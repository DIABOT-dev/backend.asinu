'use strict';

process.env.JWT_SECRET = 'chat-session-test-only';
process.env.DOCTOR_ALLOWED_TENANT_IDS = 'security-chat';
const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');
const { once } = require('events');
jest.mock('../../src/services/integrations/doctor-task.service', () => ({
  ...jest.requireActual('../../src/services/integrations/doctor-task.service'),
  deliverDoctorRequest: jest.fn().mockResolvedValue({ status: 200 }),
}));
const { deliverDoctorRequest } = require('../../src/services/integrations/doctor-task.service');
const {
  attachDoctorChatWebSocketServer,
  broadcastChatEvent,
  chatPresence,
  readDoctorPresence,
  recordDoctorPresence,
  updateDoctorPresence,
} = require('../../src/services/integrations/doctor-chat-realtime');

let server;
let attached;
let port;
let version;
let pool;
const token = () =>
  jwt.sign({ id: 7, auth_version: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const connect = () =>
  new WebSocket(
    `ws://127.0.0.1:${port}/api/doctor/chat/ws?tenant_id=security-chat&task_id=task-7`,
    ['asinu-chat', token()]
  );

beforeEach(async () => {
  deliverDoctorRequest.mockClear();
  version = 0;
  pool = {
    query: jest.fn(async (sql) => ({
      rows: sql.startsWith('SELECT auth_token_version')
        ? [{ auth_token_version: version }]
        : [{ exists: 1 }],
    })),
  };
  server = http.createServer();
  attached = attachDoctorChatWebSocketServer(server, pool);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
afterEach(async () => {
  await attached.close();
  await new Promise((resolve) => server.close(resolve));
});

test('a revoked JWT cannot establish a health-chat WebSocket', async () => {
  version = 1;
  const socket = connect();
  const rejected = new Promise((resolve) =>
    socket.once('unexpected-response', (_req, response) => {
      resolve(response.statusCode);
      response.resume();
      socket.terminate();
    })
  );
  socket.on('error', () => {});
  expect(await rejected).toBe(401);
});

test('logout blocks message delivery to a previously connected socket', async () => {
  const socket = connect();
  const messages = [];
  socket.on('message', (message) => messages.push(JSON.parse(message.toString())));
  await once(socket, 'message');
  const closed = once(socket, 'close');
  version = 1;
  broadcastChatEvent({
    tenantId: 'security-chat',
    taskId: 'task-7',
    type: 'chat.message',
    data: { private: 'health content' },
  });
  const [code] = await closed;
  expect(code).toBe(1008);
  expect(messages.map((message) => message.type)).toEqual(['chat.ready']);
});

test('only the first patient connection and final disconnect signal presence', async () => {
  expect(chatPresence('security-chat', 'task-7')).toEqual({ status: 'offline' });
  const socket = connect();
  await once(socket, 'message');

  expect(chatPresence('security-chat', 'task-7')).toMatchObject({ status: 'online' });
  expect(chatPresence('security-chat', 'other-task')).toEqual({ status: 'offline' });
  expect(deliverDoctorRequest).toHaveBeenCalledWith('chat-events', expect.objectContaining({
    tenant_id: 'security-chat',
    payload: { task_id: 'task-7', app_user_id: '7', action: 'presence' },
  }), expect.any(String));

  const secondSocket = connect();
  await once(secondSocket, 'message');
  expect(deliverDoctorRequest).toHaveBeenCalledTimes(1);

  const closed = once(socket, 'close');
  socket.close();
  await closed;
  expect(chatPresence('security-chat', 'task-7')).toMatchObject({ status: 'online' });
  expect(deliverDoctorRequest).toHaveBeenCalledTimes(1);

  const finalSignal = new Promise((resolve) => {
    deliverDoctorRequest.mockImplementationOnce(() => {
      resolve();
      return Promise.resolve({ status: 200 });
    });
  });
  const finalClose = once(secondSocket, 'close');
  secondSocket.close();
  await Promise.all([finalClose, finalSignal]);
  expect(chatPresence('security-chat', 'task-7')).toEqual({ status: 'offline' });
  expect(deliverDoctorRequest).toHaveBeenCalledTimes(2);
});

test('closing one doctor tab keeps the other active and ignores stale online updates', async () => {
  const socket = connect();
  await once(socket, 'message');
  const doctorRef = 'expert-multi-tab';
  const report = (sessionId, revision, active) =>
    updateDoctorPresence('security-chat', 'task-7', doctorRef, { sessionId, revision, active });
  const presence = () => readDoctorPresence('security-chat', 'task-7', doctorRef);

  const opened = once(socket, 'message');
  report('tab-a', 1, true);
  expect(JSON.parse((await opened)[0].toString()).data.status).toBe('online');
  report('tab-b', 1, true);
  report('tab-a', 3, false);
  expect(presence().status).toBe('online');

  const closed = new Promise((resolve) => {
    socket.on('message', (payload) => {
      const { data } = JSON.parse(payload.toString());
      if (data.status === 'offline') resolve(data);
    });
  });
  report('tab-b', 2, false);
  expect(await closed).toEqual({ doctor_ref: doctorRef, status: 'offline', expires_at: null });
  report('tab-a', 2, true);
  expect(presence().status).toBe('offline');

  const disconnect = once(socket, 'close');
  socket.close();
  await disconnect;
});

test('the authorized task socket receives the expert presence pulse for its consultation', async () => {
  const socket = connect();
  await once(socket, 'message');
  const event = once(socket, 'message');
  recordDoctorPresence('security-chat', 'other-task', 'other-expert');
  recordDoctorPresence('security-chat', 'task-7', 'expert-7');
  const [payload] = await event;
  expect(JSON.parse(payload.toString())).toMatchObject({
    type: 'chat.doctor.presence.changed',
    data: { doctor_ref: 'expert-7', status: 'online', expires_at: expect.any(String) },
  });
  socket.close();
  await once(socket, 'close');
});

test('database failures cannot expose health messages over an established socket', async () => {
  const socket = connect();
  const messages = [];
  socket.on('message', (message) => messages.push(JSON.parse(message.toString())));
  await once(socket, 'message');
  const closed = once(socket, 'close');
  pool.query.mockRejectedValue(new Error('database unavailable'));
  broadcastChatEvent({
    tenantId: 'security-chat',
    taskId: 'task-7',
    type: 'chat.message',
    data: { private: 'health content' },
  });
  const [code] = await closed;
  expect(code).toBe(1011);
  expect(messages.map((message) => message.type)).toEqual(['chat.ready']);
});
