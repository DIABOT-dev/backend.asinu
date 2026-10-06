'use strict';

const { synthesizeSpeech, MAX_AUDIO_BYTES } = require('../../src/services/voice/vieneu.service');
const audio = require('../../src/services/checkin-call/audio.service');
const voice = 'clone_b935a451-7d65-4b73-a083-d46e56c47d4f';
const options = { text: 'Xin chào.', voice, apiKey: 'private-test-key', timeoutMs: 5000 };
const wav = Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(100)]);
const json = (data) => ({ ok: true, json: async () => data });
const recording = (data = wav, mime = 'audio/wav') => ({
  ok: true,
  headers: { get: (key) => (key === 'content-type' ? mime : null) },
  arrayBuffer: async () => data,
});
const completed = {
  status: 'completed',
  voiceId: voice,
  audioUrl: 'https://storage.vieneu.io/test.wav',
};
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});
afterEach(() => {
  global.fetch = originalFetch;
});

test('clone submission, polling and download use the exact private voice without leaking its API key', async () => {
  global.fetch
    .mockResolvedValueOnce(json({ jobId: 'job-1', status: 'queued' }))
    .mockResolvedValueOnce(json(completed))
    .mockResolvedValueOnce(recording());
  const result = await synthesizeSpeech(options);
  expect(result).toEqual({ audio_data: wav, mime_type: 'audio/wav' });
  const [url, submitted] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.vieneu.io/api/v1/tts');
  expect(JSON.parse(submitted.body)).toEqual({
    text: options.text,
    voiceId: voice,
    engine: 'v4',
    speed: 1,
    aiRefine: false,
  });
  expect(submitted.headers['Idempotency-Key']).toMatch(/^[\da-f-]{36}$/);
  expect(global.fetch.mock.calls[1][0]).toBe('https://api.vieneu.io/api/v1/tts/job-1');
  expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer private-test-key');
  expect(global.fetch.mock.calls[2][1].headers).toBeUndefined();
  expect(global.fetch.mock.calls.every(([, request]) => request.signal === submitted.signal)).toBe(
    true
  );
});

test('completed provider cache downloads immediately and detects WAV with a generic content type', async () => {
  global.fetch
    .mockResolvedValueOnce(json(completed))
    .mockResolvedValueOnce(recording(wav, 'application/octet-stream'));
  expect((await synthesizeSpeech(options)).mime_type).toBe('audio/wav');
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test('catalogue voices retain the binary MP3 endpoint', async () => {
  global.fetch.mockResolvedValueOnce(recording(Buffer.from('mp3'), 'audio/mpeg'));
  const result = await synthesizeSpeech({ ...options, voice: 'Tuấn Anh' });
  expect(global.fetch.mock.calls[0][0]).toBe('https://api.vieneu.io/api/v1/audio/speech');
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
    input: options.text,
    voice: 'Tuấn Anh',
    response_format: 'mp3',
  });
  expect(result.mime_type).toBe('audio/mpeg');
});

test.each([
  [{ ...completed, voiceId: 'clone_wrong' }, 'VieNeu voice mismatch'],
  [
    { jobId: 'job-1', status: 'failed', error: 'secret provider details' },
    'VieNeu synthesis failed',
  ],
  [{ status: 'queued' }, 'VieNeu synthesis failed'],
  [{ ...completed, audioUrl: 'http://storage.vieneu.io/test.wav' }, 'Invalid VieNeu audio URL'],
  [
    { ...completed, audioUrl: 'https://key:secret@storage.vieneu.io/test.wav' },
    'Invalid VieNeu audio URL',
  ],
])(
  'invalid clone jobs fail without changing to a catalogue voice or exposing provider details',
  async (job, message) => {
    global.fetch.mockResolvedValueOnce(json(job));
    await expect(synthesizeSpeech(options)).rejects.toThrow(message);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  }
);

test('queued jobs time out without repeatedly submitting or downloading', async () => {
  global.fetch.mockResolvedValueOnce(json({ jobId: 'job-1', status: 'queued' }));
  await expect(synthesizeSpeech({ ...options, timeoutMs: 30 })).rejects.toThrow('VieNeu timed out');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('clone WAV conclusions over 2 MB remain valid while oversized downloads are rejected before buffering', async () => {
  const long = Buffer.concat([wav, Buffer.alloc(2_100_000)]);
  global.fetch.mockResolvedValueOnce(json(completed)).mockResolvedValueOnce(recording(long));
  expect((await synthesizeSpeech(options)).audio_data.length).toBe(long.length);
  const body = { cancel: jest.fn() };
  const read = jest.fn();
  global.fetch.mockResolvedValueOnce(json(completed)).mockResolvedValueOnce({
    ok: true,
    body,
    headers: {
      get: (key) => (key === 'content-length' ? String(MAX_AUDIO_BYTES + 1) : 'audio/wav'),
    },
    arrayBuffer: read,
  });
  await expect(synthesizeSpeech(options)).rejects.toThrow('Invalid VieNeu audio');
  expect(body.cancel).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
});

test('non-audio clone downloads are rejected and transport exceptions are sanitized', async () => {
  global.fetch
    .mockResolvedValueOnce(json(completed))
    .mockResolvedValueOnce(recording(Buffer.from('private error'), 'application/json'));
  await expect(synthesizeSpeech(options)).rejects.toThrow('Invalid VieNeu audio');
  global.fetch.mockRejectedValueOnce(new Error('signed secret download URL'));
  await expect(synthesizeSpeech(options)).rejects.toThrow('VieNeu unavailable');
});

test('check-in audio uses the clone for conclusions and returns its actual format and revision', async () => {
  const previous = process.env.VIENEU_VOICE;
  const previousKey = process.env.VIENEU_API_KEY;
  try {
    process.env.VIENEU_VOICE = voice;
    process.env.VIENEU_API_KEY = options.apiKey;
    global.fetch.mockResolvedValueOnce(json(completed)).mockResolvedValueOnce(recording());
    expect(await audio.synthesizeText(options.text)).toEqual({
      audio_data: wav,
      mime_type: 'audio/wav',
      audio_version: audio.audioVersion('vi'),
    });
    expect(audio.audioMimeType('vi')).toBe('audio/wav');
  } finally {
    if (previous === undefined) delete process.env.VIENEU_VOICE;
    else process.env.VIENEU_VOICE = previous;
    if (previousKey === undefined) delete process.env.VIENEU_API_KEY;
    else process.env.VIENEU_API_KEY = previousKey;
  }
});
