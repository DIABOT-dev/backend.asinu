'use strict';

const { createAttemptToken } = require('../../src/services/checkin-call/access.service');

const envKeys = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('does not query an attempt when LiveKit is unavailable', async () => {
  for (const key of envKeys) delete process.env[key];
  const pool = { query: jest.fn() };
  await expect(createAttemptToken(pool, 'attempt', 7)).resolves.toEqual({ unavailable: true });
  expect(pool.query).not.toHaveBeenCalled();
});

test('checks the target user and active attempt state before issuing a token', async () => {
  process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret-long-enough';
  const pool = { query: jest.fn().mockResolvedValue({ rows: [{ room_name: 'room-1', state: 'CLOSED' }] }) };
  await expect(createAttemptToken(pool, 'attempt', 7)).resolves.toEqual({ notFound: true });
  expect(pool.query.mock.calls[0][1]).toEqual(['attempt', 7]);
});
