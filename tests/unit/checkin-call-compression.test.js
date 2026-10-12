'use strict';

jest.mock('../../src/services/voice/vieneu.service', () => ({
  ...jest.requireActual('../../src/services/voice/vieneu.service'),
  synthesizeSpeech: jest.fn(),
}));

const audio = require('../../src/services/checkin-call/audio.service');
const { synthesizeSpeech } = require('../../src/services/voice/vieneu.service');
const names = ['CHECKIN_CALL_AUDIO_FORMAT', 'VIENEU_VOICE'];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

function wav() {
  const samples = 48000;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
  return data;
}

beforeEach(() => {
  process.env.VIENEU_VOICE = audio.DEFAULT_ASINU_VOICE;
  synthesizeSpeech.mockReset();
  synthesizeSpeech.mockResolvedValue({ audio_data: wav(), mime_type: 'audio/wav' });
});
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

test('MP3 delivery reduces the actual clone recording and matches public metadata/revision', async () => {
  delete process.env.CHECKIN_CALL_AUDIO_FORMAT;
  const oldVersion = audio.audioVersion('vi');
  process.env.CHECKIN_CALL_AUDIO_FORMAT = 'mp3';
  const result = await audio.synthesizeText('Xin chào, đây là Asinu.');
  expect(result.mime_type).toBe('audio/mpeg');
  expect(result.mime_type).toBe(audio.audioMimeType('vi'));
  expect(result.audio_version).toBe(audio.audioVersion('vi'));
  expect(result.audio_version).not.toBe(oldVersion);
  expect(result.audio_data.subarray(0, 3).toString()).toBe('ID3');
  expect(result.audio_data.length).toBeLessThan(wav().length / 4);
  expect(synthesizeSpeech.mock.calls[0][0].voice).toBe(audio.DEFAULT_ASINU_VOICE);
}, 10000);

test('the original provider format remains available when compression is disabled', async () => {
  delete process.env.CHECKIN_CALL_AUDIO_FORMAT;
  const result = await audio.synthesizeText('Xin chào.');
  expect(result.mime_type).toBe('audio/wav');
  expect(result.audio_data).toEqual(wav());
});

test('bad provider bytes cannot be cached as a successful MP3 recording', async () => {
  process.env.CHECKIN_CALL_AUDIO_FORMAT = 'mp3';
  synthesizeSpeech.mockResolvedValue({
    audio_data: Buffer.from('invalid'),
    mime_type: 'audio/wav',
  });
  await expect(audio.synthesizeText('Xin chào.')).rejects.toMatchObject({
    statusCode: 503,
    i18nKey: 'checkinCall.error.audio_unavailable',
  });
}, 10000);
