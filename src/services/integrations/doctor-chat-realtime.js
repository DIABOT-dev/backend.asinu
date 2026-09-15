const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocket, WebSocketServer } = require('ws');
const { assertTenantAllowed } = require('./doctor-task.service');

const CHAT_PATH = '/api/doctor/chat/ws';
const CHAT_PROTOCOL = 'asinu-chat';
const HEARTBEAT_MS = 30_000;

const connections = new Map();
let webSocketServer = null;

const taskKey = (tenantId, taskId) => `${tenantId}:${taskId}`;

const send = (socket, type, data) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, data }));
};

const broadcastChatEvent = ({ tenantId, taskId, type, data }) => {
  const clients = connections.get(taskKey(tenantId, taskId));
  if (!clients) return;
  for (const socket of clients) send(socket, type, data);
};

const tokenFromProtocols = (request) => {
  const raw = request.headers['sec-websocket-protocol'];
  const protocols = String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return protocols.find((protocol) => protocol !== CHAT_PROTOCOL) || null;
};

const hasChatProtocol = (request) => {
  const raw = request.headers['sec-websocket-protocol'];
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .includes(CHAT_PROTOCOL);
};

const authenticate = (token) => {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload?.id ?? payload?.user_id;
    if (!userId) return null;
    return { userId: String(userId) };
  } catch {
    return null;
  }
};

const ownsTask = async (pool, tenantId, taskId, userId) => {
  const result = await pool.query(
    `SELECT 1
       FROM doctor_task_outbox
      WHERE tenant_id = $1
        AND payload->'payload'->>'task_id' = $2
        AND payload->'payload'->>'app_user_id' = $3
      LIMIT 1`,
    [tenantId, taskId, userId]
  );
  return Boolean(result.rows[0]);
};

const rejectUpgrade = (socket, status = 401) => {
  const label = status === 500 ? 'Internal Server Error' : 'Unauthorized';
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
};

const originAllowed = (request) => {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const requestHost = new URL(`http://${request.headers.host || 'localhost'}`).hostname;
    return new URL(origin).hostname === requestHost;
  } catch {
    return false;
  }
};

const attachDoctorChatWebSocketServer = (server, pool) => {
  if (!(server instanceof http.Server)) throw new TypeError('A HTTP server is required.');
  const instance = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(CHAT_PROTOCOL) ? CHAT_PROTOCOL : CHAT_PROTOCOL),
  });
  webSocketServer = instance;

  instance.on('connection', (socket, request) => {
    const auth = request.doctorChatAuth;
    const url = new URL(request.url || CHAT_PATH, `http://${request.headers.host || 'localhost'}`);
    const tenantId = String(url.searchParams.get('tenant_id') || '').trim();
    const taskId = String(url.searchParams.get('task_id') || '').trim();
    const key = taskKey(tenantId, taskId);
    const clients = connections.get(key) || new Set();
    clients.add(socket);
    connections.set(key, clients);

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    socket.on('pong', () => {
      alive = true;
    });
    send(socket, 'chat.ready', { transport: 'websocket', task_id: taskId });
    socket.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(socket);
      if (!clients.size) connections.delete(key);
    });
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    } catch {
      rejectUpgrade(socket);
      return;
    }
    if (url.pathname !== CHAT_PATH) return;
    if (!originAllowed(request)) {
      rejectUpgrade(socket);
      return;
    }
    const tenantId = String(url.searchParams.get('tenant_id') || '').trim();
    const taskId = String(url.searchParams.get('task_id') || '').trim();
    const auth = authenticate(tokenFromProtocols(request));
    if (
      !hasChatProtocol(request) ||
      !auth ||
      !tenantId ||
      tenantId.length > 120 ||
      !taskId ||
      taskId.length > 160
    ) {
      rejectUpgrade(socket);
      return;
    }
    try {
      assertTenantAllowed(tenantId);
    } catch {
      rejectUpgrade(socket);
      return;
    }
    void ownsTask(pool, tenantId, taskId, auth.userId)
      .then((owned) => {
        if (!owned) {
          rejectUpgrade(socket);
          return;
        }
        request.doctorChatAuth = auth;
        instance.handleUpgrade(request, socket, head, (webSocket) => {
          instance.emit('connection', webSocket, request);
        });
      })
      .catch(() => rejectUpgrade(socket, 500));
  });

  return {
    close: async () => {
      for (const clients of connections.values()) {
        for (const socket of clients) socket.terminate();
      }
      connections.clear();
      await new Promise((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
      });
      if (webSocketServer === instance) webSocketServer = null;
    },
  };
};

module.exports = {
  CHAT_PATH,
  CHAT_PROTOCOL,
  attachDoctorChatWebSocketServer,
  broadcastChatEvent,
};
