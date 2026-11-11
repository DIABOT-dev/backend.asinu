'use strict';

const { createHash } = require('node:crypto');
const audio = require('./audio.service');
const { encodeMp3, concatenateMp3 } = require('../voice/mp3.service');
const { normalizeCheckinSpeech } = require('./speech-text');

const recordings = new Map();
const pending = new Map();
const TTL_MS = 5 * 60_000;
const MAX_CACHE_BYTES = 16_000_000;
let cacheBytes = 0;
const MAX_CONCLUSION_TEXT_LENGTH = 32_000;
const CONCLUSION_SYNTHESIS_DEADLINE_MS = 120_000;
const PREWARM_WAIT_MS = 20_000;
const MAX_PARALLEL_SEGMENTS = 3;
const MAX_PENDING_RECORDINGS = 8;
let activeSegments = 0;
const waitingSegments = [];

const unavailable = (message) =>
  Object.assign(new Error(message), {
    statusCode: 503,
    i18nKey: 'checkinCall.error.audio_unavailable',
  });

async function synthesisSlot(deadline, operation) {
  await new Promise((resolve, reject) => {
    if (activeSegments < MAX_PARALLEL_SEGMENTS) {
      activeSegments++;
      resolve();
      return;
    }
    const entry = { resolve, reject, deadline, timer: null };
    entry.timer = setTimeout(
      () => {
        const index = waitingSegments.indexOf(entry);
        if (index >= 0) waitingSegments.splice(index, 1);
        reject(unavailable('Conclusion synthesis deadline exceeded'));
      },
      Math.max(1, deadline - Date.now())
    );
    waitingSegments.push(entry);
  });
  try {
    if (Date.now() >= deadline) throw unavailable('Conclusion synthesis deadline exceeded');
    return await operation();
  } finally {
    activeSegments--;
    let entry = waitingSegments.shift();
    while (entry && entry.deadline <= Date.now()) {
      clearTimeout(entry.timer);
      entry.reject(unavailable('Conclusion synthesis deadline exceeded'));
      entry = waitingSegments.shift();
    }
    if (entry) {
      activeSegments++;
      clearTimeout(entry.timer);
      entry.resolve();
    }
  }
}

function conclusionText(input, language = 'vi') {
  const text = typeof input === 'string' ? input.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  // Keep the existing validation/limits even if removing repeats would shorten it.
  if (!text || text.length > MAX_CONCLUSION_TEXT_LENGTH) return text;
  const seen = new Set();
  const sentences = [];
  for (const { segment } of new Intl.Segmenter(audio.normalizeLanguage(language), {
    granularity: 'sentence',
  }).segment(normalizeCheckinSpeech(text, language))) {
    const sentence = segment.trim();
    const identity = sentence
      .replace(
        /^(?:kết luận|lời khuyên|triệu chứng đã ghi nhận|summary|advice|recorded symptoms):\s*/iu,
        ''
      )
      .replace(/[.!?…]+$/u, '')
      .toLocaleLowerCase(audio.normalizeLanguage(language));
    // Remove only identical whole statements. Never remove repeated words or
    // guess whether different medical instructions mean the same thing.
    if (identity.length >= 16 && seen.has(identity)) continue;
    seen.add(identity);
    sentences.push(sentence);
  }
  return sentences.join(' ');
}

function splitConclusionText(text, language = 'vi') {
  const result = [];
  const limit = audio.MAX_DYNAMIC_TEXT_LENGTH;
  let current = '';
  const append = (part) => {
    if (current && current.length + 1 + part.length > limit) {
      result.push(current);
      current = '';
    }
    current += (current ? ' ' : '') + part;
  };
  for (const { segment } of new Intl.Segmenter(audio.normalizeLanguage(language), {
    granularity: 'sentence',
  }).segment(text)) {
    const sentence = segment.trim();
    if (!sentence) continue;
    if (sentence.length <= limit) append(sentence);
    else {
      if (current) {
        result.push(current);
        current = '';
      }
      for (const word of sentence.split(/\s+/u)) {
        for (let offset = 0; offset < word.length; offset += limit)
          append(word.slice(offset, offset + limit));
      }
    }
  }
  if (current) result.push(current);
  return result;
}

async function synthesizeConclusion(text, language, version) {
  if (!text || text.length > MAX_CONCLUSION_TEXT_LENGTH) {
    throw Object.assign(new Error('Invalid conclusion text length'), {
      statusCode: 400,
      i18nKey: text
        ? 'checkinCall.error.conclusion_too_long'
        : 'checkinCall.error.conclusion_required',
    });
  }
  const segments = splitConclusionText(text, language);
  const recordings = new Array(segments.length);
  const recordingVersions = new Set();
  let next = 0,
    failure = null;
  const deadline = Date.now() + CONCLUSION_SYNTHESIS_DEADLINE_MS;
  // Bounded parallel requests prepare a single complete recording. All workers
  // settle before failure is returned; a replay cannot overlap abandoned jobs.
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_SEGMENTS, segments.length) }, async () => {
      while (!failure && next < segments.length) {
        const index = next++;
        try {
          await synthesisSlot(deadline, async () => {
            const data = await audio.synthesizeText(segments[index], language, {
              timeoutMs: deadline - Date.now(),
            });
            recordingVersions.add(data.audio_version);
            const mp3 = data.mime_type === 'audio/mpeg' ? data : await encodeMp3(data.audio_data);
            recordings[index] = mp3.audio_data;
          });
        } catch (error) {
          failure ||= error;
        }
      }
    })
  );
  if (failure) throw failure;
  if (recordingVersions.size !== 1)
    throw Object.assign(new Error('Conclusion voice changed during synthesis'), {
      statusCode: 503,
    });
  if (Date.now() >= deadline)
    throw Object.assign(new Error('Conclusion synthesis deadline exceeded'), { statusCode: 503 });
  const complete = await synthesisSlot(deadline, () => concatenateMp3(recordings));
  return { ...complete, audio_version: [...recordingVersions][0] || version };
}

async function getConclusionAudio(userId, input, requestedLanguage = 'vi') {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) {
    throw Object.assign(new Error('Recipient is required'), { statusCode: 401 });
  }
  const language = audio.normalizeLanguage(requestedLanguage);
  const text = conclusionText(input, language);
  const version = audio.audioVersion(language);
  const key = createHash('sha256')
    .update(JSON.stringify([String(userId), language, version, text]))
    .digest('hex');
  const now = Date.now();
  for (const [oldKey, entry] of recordings) {
    if (entry.expires <= now) {
      cacheBytes -= entry.data.audio_data.length;
      recordings.delete(oldKey);
    }
  }
  const stored = recordings.get(key);
  if (stored) return stored.data;
  let job = pending.get(key);
  if (!job) {
    if (pending.size >= MAX_PENDING_RECORDINGS) throw unavailable('Conclusion synthesis is busy');
    job = synthesizeConclusion(text, language, version).then((data) => {
      const size = data.audio_data.length;
      if (data.audio_version === version && size <= MAX_CACHE_BYTES) {
        while (recordings.size >= 64 || cacheBytes + size > MAX_CACHE_BYTES) {
          const oldest = recordings.keys().next().value;
          cacheBytes -= recordings.get(oldest).data.audio_data.length;
          recordings.delete(oldest);
        }
        recordings.set(key, { data, expires: Date.now() + TTL_MS });
        cacheBytes += size;
      }
      return data;
    });
    pending.set(key, job);
  }
  try {
    return await job;
  } finally {
    if (pending.get(key) === job) pending.delete(key);
  }
}

async function prepareConclusionAudio(userId, result, language, waitMs = PREWARM_WAIT_MS) {
  if (
    !result?.isDone ||
    result.conclusionVersion !== 2 ||
    result.severity === 'emergency' ||
    !result.speechText
  )
    return;
  // Completion has already been committed by the caller. Voice availability
  // never rolls it back; finish the cache in the background if preparation is slow.
  let timer;
  try {
    await Promise.race([
      getConclusionAudio(userId, result.speechText, language).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  MAX_CONCLUSION_TEXT_LENGTH,
  PREWARM_WAIT_MS,
  conclusionText,
  splitConclusionText,
  getConclusionAudio,
  prepareConclusionAudio,
};
