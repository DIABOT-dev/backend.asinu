'use strict';

const { createHash } = require('node:crypto');
const audio = require('./audio.service');

const recordings = new Map();
const pending = new Map();
const TTL_MS = 5 * 60_000;
const MAX_CACHE_BYTES = 16_000_000;
let cacheBytes = 0;

function conclusionText(input, language = 'vi') {
  const text = typeof input === 'string' ? input.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  // Keep the existing validation/limits even if removing repeats would shorten it.
  if (!text || text.length > audio.MAX_DYNAMIC_TEXT_LENGTH) return text;
  const seen = new Set();
  const sentences = [];
  for (const { segment } of new Intl.Segmenter(audio.normalizeLanguage(language), {
    granularity: 'sentence',
  }).segment(text)) {
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
    job = audio.synthesizeText(text, language).then((data) => {
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

module.exports = { conclusionText, getConclusionAudio };
