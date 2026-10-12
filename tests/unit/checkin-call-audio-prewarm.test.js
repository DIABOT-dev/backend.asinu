'use strict';

jest.mock('../../src/services/checkin-call/personalization.service', () => ({
  userAudio: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/audio.service', () => ({
  synthesizeText: jest.fn(),
  audioVersion: jest.fn(() => 'voice-v1'),
}));
jest.mock('../../src/services/notification/fcm.notification.service', () => ({
  sendFcmNotification: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/notification/apns.voip.service', () => ({
  sendVoipNotification: jest.fn().mockResolvedValue({ ok: false }),
}));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const service = require('../../src/services/checkin-call/checkin-call.service');
const personalization = require('../../src/services/checkin-call/personalization.service');
const audio = require('../../src/services/checkin-call/audio.service');
const { sendFcmNotification } = require('../../src/services/notification/fcm.notification.service');
const originalKey = process.env.VIENEU_API_KEY;
const data = {
  audio_data: Buffer.from('speech'),
  mime_type: 'audio/mpeg',
  audio_version: 'voice-v1',
};
const delivery = { attempt_id: 'user-attempt', target_user_id: 7, target_role: 'USER' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.VIENEU_API_KEY = 'test-key';
  audio.audioVersion.mockReturnValue('voice-v1');
  audio.synthesizeText.mockResolvedValue(data);
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.VIENEU_API_KEY;
  else process.env.VIENEU_API_KEY = originalKey;
});

test('delivery reaches FCM while opening speech is still being generated', async () => {
  let finish;
  personalization.userAudio.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const row = {
    ...delivery,
    id: 'delivery',
    episode_id: 'episode',
    kind: 'INCOMING_CALL',
    state: 'PENDING',
    tries: 0,
    episode_state: 'CONTACT_USER',
    attempt_state: 'RINGING',
    lang: 'vi',
    severity: 'NONE',
    config: {},
    fcm_token: 'device',
  };
  const db = {
    query: jest.fn(async (sql) => ({ rows: sql.includes('SELECT d.*') ? [row] : [] })),
    release: jest.fn(),
  };
  const pool = {
    connect: async () => db,
    query: jest.fn(async (sql) => ({ rows: sql.includes('SELECT d.id') ? [{ id: row.id }] : [] })),
  };
  await service.dispatchDeliveries(pool);
  expect(sendFcmNotification).toHaveBeenCalledTimes(1);
  expect(personalization.userAudio).toHaveBeenCalledWith(
    pool,
    row.attempt_id,
    7,
    'user_prompt',
    'vi'
  );
  const warming = service._test.prewarmOpeningAudio(pool, row, 'vi');
  expect(personalization.userAudio).toHaveBeenCalledTimes(1);
  finish(data);
  await warming;
});

test('prewarm failure is contained and the next request can retry', async () => {
  personalization.userAudio
    .mockRejectedValueOnce(new Error('provider unavailable'))
    .mockResolvedValue(data);
  await expect(service._test.prewarmOpeningAudio({}, delivery, 'vi')).resolves.toBeUndefined();
  await service._test.prewarmOpeningAudio({}, delivery, 'vi');
  expect(personalization.userAudio).toHaveBeenCalledTimes(2);
});

function familyPool(authorized = true) {
  return {
    query: jest.fn(async () => ({
      rows: authorized
        ? [
            {
              id: 'family-attempt',
              episode_id: 'episode',
              target_role: 'FAMILY',
              severity: 'MILD',
              subject_name: 'Lan',
              subject_gender: 'female',
              subject_phone: '0900000000',
            },
          ]
        : [],
    })),
  };
}

test('family prewarm and playback share synthesis, but every read still checks authorization', async () => {
  const pool = familyPool();
  const row = { attempt_id: 'family-attempt', target_user_id: 8, target_role: 'FAMILY' };
  await service._test.prewarmOpeningAudio(pool, row, 'vi');
  const replay = await service.getFamilyAudio(pool, row.attempt_id, 8, 'vi');
  expect(replay).toBe(data);
  expect(audio.synthesizeText).toHaveBeenCalledTimes(1);
  await expect(
    service.getFamilyAudio(familyPool(false), row.attempt_id, 8, 'vi')
  ).rejects.toMatchObject({ statusCode: 404 });
  audio.audioVersion.mockReturnValue('voice-v2');
  audio.synthesizeText.mockResolvedValue({ ...data, audio_version: 'voice-v2' });
  await service.getFamilyAudio(pool, row.attempt_id, 8, 'vi');
  expect(audio.synthesizeText).toHaveBeenCalledTimes(2);
});
