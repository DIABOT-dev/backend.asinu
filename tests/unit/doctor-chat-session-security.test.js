'use strict';

process.env.JWT_SECRET = 'chat-session-test-only';
process.env.DOCTOR_ALLOWED_TENANT_IDS = 'security-chat';
const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');
const { once } = require('events');
const {
  attachDoctorChatWebSocketServer,
  broadcastChatEvent,
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
