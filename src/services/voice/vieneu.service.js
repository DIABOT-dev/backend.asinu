'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const API_URL = 'https://api.vieneu.io/api/v1';
// Clone jobs return uncompressed WAV; a 1,600-character conclusion can exceed
// the old 2 MB MP3 limit. Bound downloads before buffering them in memory.
const MAX_AUDIO_BYTES = 20_000_000;

function isClonedVoice(voice) {
  return typeof voice === 'string' && voice.startsWith('clone_');
}

function voiceMimeType(voice) {
  return isClonedVoice(voice) ? 'audio/wav' : 'audio/mpeg';
}

async function readAudio(response, voice) {
  if (!response.ok) throw new Error('VieNeu failed');
  if (Number(response.headers?.get?.('content-length')) > MAX_AUDIO_BYTES) {
    await response.body?.cancel?.();
    throw new Error('Invalid VieNeu audio');
  }
  let data;
  if (response.body?.[Symbol.asyncIterator]) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) throw new Error('Invalid VieNeu audio');
      chunks.push(chunk);
    }
    data = Buffer.concat(chunks, size);
  } else {
    data = Buffer.from(await response.arrayBuffer());
  }
  if (!data.length || data.length > MAX_AUDIO_BYTES) throw new Error('Invalid VieNeu audio');
  const wav = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
  const contentType = response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase();
  const mimeType = wav ? 'audio/wav' : contentType?.startsWith('audio/') ? contentType : null;
  if (isClonedVoice(voice) && !mimeType) throw new Error('Invalid VieNeu audio');
  return { audio_data: data, mime_type: mimeType || 'audio/mpeg' };
}

async function clonedSpeech(text, voice, headers, signal) {
  // Do not retry submission: one idempotency key identifies this synthesis.
  const submitted = await fetch(API_URL + '/tts', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ text, voiceId: voice, engine: 'v4', speed: 1, aiRefine: false }),
    signal,
  });
  if (!submitted.ok) throw new Error('VieNeu failed');
  let job = await submitted.json();
  const jobId = job.jobId;
  while (job.status !== 'completed') {
    signal.throwIfAborted();
    if (job.voiceId && job.voiceId !== voice) throw new Error('VieNeu voice mismatch');
    if (!jobId || !['queued', 'pending', 'processing', 'running'].includes(job.status)) {
      throw new Error('VieNeu synthesis failed');
    }
    await delay(1000, undefined, { signal });
    const status = await fetch(API_URL + '/tts/' + encodeURIComponent(jobId), { headers, signal });
    if (!status.ok) throw new Error('VieNeu failed');
    job = await status.json();
  }
  signal.throwIfAborted();
  if (job.voiceId && job.voiceId !== voice) throw new Error('VieNeu voice mismatch');
  let url;
  try {
    url = new URL(job.audioUrl);
  } catch {
    throw new Error('Invalid VieNeu audio URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Invalid VieNeu audio URL');
  // Signed storage URLs must never receive the API bearer key.
  return readAudio(await fetch(url.href, { signal }), voice);
}

async function synthesizeSpeech({ text, voice, apiKey, timeoutMs = 20000 }) {
  if (!apiKey) throw new Error('VieNeu is not configured');
  if (!voice || !text) throw new Error('VieNeu text and voice are required');
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { Authorization: 'Bearer ' + apiKey };
  try {
    if (isClonedVoice(voice)) return await clonedSpeech(text, voice, headers, signal);
    const response = await fetch(API_URL + '/audio/speech', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice, response_format: 'mp3' }),
      signal,
    });
    return await readAudio(response, voice);
  } catch (error) {
    if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) {
      throw new Error('VieNeu timed out');
    }
    // Provider bodies and signed URLs can contain private data. Never expose
    // them through HTTP errors or logs, including malformed JSON failures.
    if (error?.message?.startsWith('VieNeu ') || error?.message?.startsWith('Invalid VieNeu '))
      throw error;
    throw new Error('VieNeu unavailable');
  }
}

module.exports = { MAX_AUDIO_BYTES, isClonedVoice, voiceMimeType, synthesizeSpeech };
