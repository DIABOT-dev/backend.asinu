'use strict';

const audio = require('../../src/services/checkin-call/audio.service');

describe('backend-owned check-in call audio revisions', () => {
  const envNames = ['VIENEU_API_KEY', 'VIENEU_VOICE', 'VIENEU_VOICE_EN', 'CHECKIN_CALL_AUDIO_REVISION'];
  const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.VIENEU_API_KEY = 'test-key';
    process.env.VIENEU_VOICE = 'test-vietnamese';
    process.env.VIENEU_VOICE_EN = 'test-english';
    process.env.CHECKIN_CALL_AUDIO_REVISION = '1';
    global.fetch = jest.fn(async (_url, options) => ({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => Buffer.from(JSON.parse(options.body).voice),
    }));
  });

  afterEach(() => {
    for (const name of envNames) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    global.fetch = originalFetch;
  });

  test('the opaque revision is stable and contains no credentials', () => {
    const version = audio.audioVersion('vi');
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    expect(audio.audioVersion('vi-VN')).toBe(version);
    process.env.VIENEU_API_KEY = 'different-test-key';
    expect(audio.audioVersion('vi')).toBe(version);
  });

  test('one configured narrator versions both locales; a legacy English override cannot change it', () => {
    const vi = audio.audioVersion('vi');
    const en = audio.audioVersion('en');
    process.env.VIENEU_VOICE = 'other-voice';
    expect(audio.audioVersion('vi')).not.toBe(vi);
    expect(audio.audioVersion('en')).not.toBe(en);
    const currentEnglish = audio.audioVersion('en');
    process.env.VIENEU_VOICE_EN = 'other-english';
    expect(audio.audioVersion('en')).toBe(currentEnglish);
  });

  test('missing or blank configuration defaults both languages to the private Tuấn Anh clone', () => {
    delete process.env.VIENEU_VOICE;
    for (const lang of ['vi', 'en']) {
      expect(audio.audioMimeType(lang)).toBe('audio/wav');
      expect(audio.audioVersion(lang)).toBe(audio.audioVersion(lang, audio.DEFAULT_ASINU_VOICE));
    }
    process.env.VIENEU_VOICE = '  ';
    expect(audio.audioMimeType('vi')).toBe('audio/wav');
  });

  test('an explicit backend revision forces regeneration without changing the voice name', () => {
    const version = audio.audioVersion('vi');
    process.env.CHECKIN_CALL_AUDIO_REVISION = '2';
    expect(audio.audioVersion('vi')).not.toBe(version);
  });

  test('Postgres cache is reused only for the matching voice and revision', async () => {
    const rows = new Map();
    const pool = {
      query: jest.fn(async (sql, args) => {
        if (sql.startsWith('SELECT')) {
          const row = rows.get(args[0]);
          return { rows: row?.hash === args[1] ? [row] : [] };
        }
        const row = { hash: args[1], mime_type: args[2], audio_data: args[3] };
        rows.set(args[0], row);
        return { rows: [row] };
      }),
    };
    const first = await audio.getAudio(pool, 'user_prompt', 'vi');
    expect(first.audio_version).toBe(audio.audioVersion('vi'));
    await audio.getAudio(pool, 'user_prompt', 'vi');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    process.env.VIENEU_VOICE = 'other-voice';
    const next = await audio.getAudio(pool, 'user_prompt', 'vi');
    expect(next.audio_version).not.toBe(first.audio_version);
    expect(next.audio_data.toString()).toBe('other-voice');
    process.env.CHECKIN_CALL_AUDIO_REVISION = '2';
    await audio.getAudio(pool, 'user_prompt', 'vi');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('dynamic conclusions report the voice actually used even if config changes during synthesis', async () => {
    const expected = audio.audioVersion('vi');
    global.fetch.mockImplementation(async () => {
      process.env.VIENEU_VOICE = 'changed-during-synthesis';
      return {
        ok: true, headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => Buffer.from('original voice'),
      };
    });
    const result = await audio.synthesizeText('Kết luận check-in.', 'vi');
    expect(result.audio_version).toBe(expected);
    expect(result.audio_version).not.toBe(audio.audioVersion('vi'));
  });
});
