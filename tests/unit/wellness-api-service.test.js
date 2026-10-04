'use strict';

jest.mock('../../src/services/wellness/wellness.monitoring.service', () => ({
  logUserActivity: jest.fn(async () => ({ id: 1 })),
  evaluateUserWellness: jest.fn(async () => ({ score: 80, status: 'OK' })),
  shouldPromptUser: jest.fn(async () => ({ shouldPrompt: false })),
  sendCaregiverAlert: jest.fn(async () => []),
}));

const wellness = require('../../src/services/wellness/wellness.monitoring.service');
const service = require('../../src/services/wellness/wellness-api.service');

beforeEach(() => jest.clearAllMocks());

test('activity evaluation releases the database client after success', async () => {
  const client = { release: jest.fn() };
  const pool = { connect: jest.fn(async () => client) };
  await expect(service.logActivityAndEvaluate(pool, 7, {
    activity_type: 'APP_OPEN', activity_data: {}, session_id: 'session-1',
  })).resolves.toMatchObject({ activity: { id: 1 }, evaluation: { score: 80 } });
  expect(wellness.logUserActivity).toHaveBeenCalledWith(client, 7, 'APP_OPEN', {}, 'session-1');
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('prompt failures still release the database client', async () => {
  const client = { release: jest.fn() };
  const pool = { connect: jest.fn(async () => client) };
  wellness.shouldPromptUser.mockRejectedValueOnce(new Error('db failed'));
  await expect(service.shouldPrompt(pool, 7)).rejects.toThrow('db failed');
  expect(client.release).toHaveBeenCalledTimes(1);
});
