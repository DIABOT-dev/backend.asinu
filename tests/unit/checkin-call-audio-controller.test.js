'use strict';

jest.mock('../../src/services/checkin-call/audio.service', () => ({
  audioVersion: jest.fn((language) => 'revision-' + language),
  getAudio: jest.fn(),
  synthesizeText: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/checkin-call.service', () => ({
  getFamilyAudio: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/personalization.service', () => ({
  userAudio: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/access.service', () => ({
  createAttemptToken: jest.fn(),
}));
jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: function requireAuth(_req, _res, next) { next(); },
}));

const { createCheckinCallController } = require('../../src/controllers/checkin-call.controller');
const routes = require('../../src/routes/checkin-call.routes');
const audio = require('../../src/services/checkin-call/audio.service');
const service = require('../../src/services/checkin-call/checkin-call.service');
const personalization = require('../../src/services/checkin-call/personalization.service');

function request(language = 'vi') {
  return {
    user: { id: 7 }, params: { id: 'attempt', key: 'user_prompt' }, body: { text: 'Conclusion' },
    headers: { 'accept-language': language },
    get: (name) => name === 'X-Checkin-Notice-Version' ? 'notice-v1' : undefined,
  };
}

function response() {
  const res = { headers: {}, body: null };
  res.set = jest.fn((key, value) => { res.headers[key] = value; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  res.status = jest.fn(() => res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

test.each(['vi', 'en'])('metadata returns the current %s revision without invoking TTS', async (language) => {
  const res = response();
  await createCheckinCallController({}).getAudioConfig(request(language), res);
  expect(res.body).toEqual({ ok: true, version: 'revision-' + language, language });
  expect(res.headers['Cache-Control']).toBe('no-store');
  expect(audio.getAudio).not.toHaveBeenCalled();
  expect(audio.synthesizeText).not.toHaveBeenCalled();
});

test('the metadata route is registered behind existing authentication', () => {
  const stack = routes({}).stack;
  const authIndex = stack.findIndex((layer) => layer.name === 'requireAuth');
  const index = stack.findIndex((layer) => layer.route?.path === '/audio-config');
  expect(authIndex).toBeGreaterThanOrEqual(0);
  expect(index).toBeGreaterThan(authIndex);
  expect(stack[index].route.methods.get).toBe(true);
});

test.each([
  ['getAudio', () => audio.getAudio],
  ['synthesizeConclusion', () => audio.synthesizeText],
  ['getUserAudio', () => personalization.userAudio],
  ['getFamilyAudio', () => service.getFamilyAudio],
])('%s returns the actual recording revision and preserves the audio payload', async (handler, mock) => {
  mock().mockResolvedValueOnce({
    audio_data: Buffer.from('audio'), mime_type: 'audio/mpeg', audio_version: 'actual-revision',
  });
  const res = response();
  await createCheckinCallController({})[handler](request('en'), res);
  expect(res.body).toEqual({
    ok: true, mimeType: 'audio/mpeg', base64: 'YXVkaW8=', audioVersion: 'actual-revision',
  });
  expect(mock().mock.calls[0]).toContain('en');
});
