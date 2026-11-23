const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocket, WebSocketServer } = require('ws');
const { randomUUID } = require('node:crypto');
const { assertTenantAllowed, deliverDoctorRequest } = require('./doctor-task.service');
const { isSessionCurrent } = require('../auth/session.service');

const CHAT_PATH = '/api/doctor/chat/ws';
const CHAT_PROTOCOL = 'asinu-chat';
const HEARTBEAT_MS = 10_000;
const DOCTOR_PRESENCE_TTL_MS = 25_000;

const connections = new Map();
const doctorPresence = new Map();
let webSocketServer = null;

const taskKey = (tenantId, taskId) => `${tenantId}:${taskId}`;
const doctorPresenceKey = (tenantId, taskId, doctorRef) => JSON.stringify([tenantId, taskId, doctorRef]);

// Presence is intentionally scoped to a consultation task.  A chat connection
// is authenticated, authorized for that task, and kept alive with ping/pong;
// message activity and typing are not used as a presence signal.
const chatPresence = (tenantId, taskId) => {
  const clients = connections.get(taskKey(tenantId, taskId));
  if (!clients?.size) return { status: 'offline' };

  let lastSeenAt = 0;
  for (const socket of clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    lastSeenAt = Math.max(lastSeenAt, socket.lastPongAt || socket.connectedAt || 0);
  }
  return lastSeenAt
    ? { status: 'online', last_seen_at: new Date(lastSeenAt).toISOString() }
    : { status: 'offline' };
};

const send = (socket, type, data) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, data }));
};

const broadcastChatEvent = ({ tenantId, taskId, type, data }) => {
  const clients = connections.get(taskKey(tenantId, taskId));
  if (!clients) return;
  for (const socket of clients) {
    // Serialize delivery and revalidate before exposing each health message.
    socket.delivery = (socket.delivery || Promise.resolve())
      .then(async () => {
        if (!(await isSessionCurrent(socket.authPool, socket.authClaims))) {
          socket.close(1008, 'Session expired');
          return;
        }
        send(socket, type, data);
      })
      .catch(() => socket.close(1011, 'Authentication unavailable'));
  }
};

const readDoctorPresence = (tenantId, taskId, doctorRef) => {
  if (!doctorRef) return null;
  const sessions = doctorPresence.get(doctorPresenceKey(tenantId, taskId, doctorRef));
  let expiresAt = 0;
  for (const session of sessions?.values() ?? []) {
    expiresAt = Math.max(expiresAt, session.expiresAt);
  }
  return expiresAt > Date.now()
    ? { doctor_ref: doctorRef, status: 'online', expires_at: new Date(expiresAt).toISOString() }
    : { doctor_ref: doctorRef, status: 'offline', expires_at: null };
};

const updateDoctorPresence = (tenantId, taskId, doctorRef, { sessionId, revision, active }) => {
  const key = doctorPresenceKey(tenantId, taskId, doctorRef);
  const sessions = doctorPresence.get(key) ?? new Map();
  const previous = sessions.get(sessionId);
  if (previous && revision <= previous.revision) return;
  const before = readDoctorPresence(tenantId, taskId, doctorRef);
  const publish = (data) => broadcastChatEvent({
    tenantId,
    taskId,
    type: 'chat.doctor.presence.changed',
    data,
  });
  if (previous) clearTimeout(previous.timer);
  // Keep the final offline revision long enough to reject a delayed online request.
  const retention = active ? DOCTOR_PRESENCE_TTL_MS : DOCTOR_PRESENCE_TTL_MS * 2;
  const timer = setTimeout(() => {
    sessions.delete(sessionId);
    if (!sessions.size) doctorPresence.delete(key);
    const current = readDoctorPresence(tenantId, taskId, doctorRef);
    if (active && current.status === 'offline') publish(current);
  }, retention);
  timer.unref();
  sessions.set(sessionId, {
    revision,
    timer,
    expiresAt: active ? Date.now() + DOCTOR_PRESENCE_TTL_MS : 0,
  });
  doctorPresence.set(key, sessions);
  const after = readDoctorPresence(tenantId, taskId, doctorRef);
  if (before.expires_at !== after.expires_at) publish(after);
};

const recordDoctorPresence = (tenantId, taskId, doctorRef) =>
  updateDoctorPresence(tenantId, taskId, doctorRef, {
    sessionId: 'legacy',
    revision: Date.now(),
    active: true,
  });

const refreshPatientPresence = (tenantId, taskId, userId) => {
  const eventId = `doctor.task.chat.changed:${taskId}:${randomUUID()}`;
  void deliverDoctorRequest('chat-events', {
    event_id: eventId,
    idempotency_key: eventId,
    event_type: 'doctor.task.chat.changed',
    occurred_at: new Date().toISOString(),
    source: 'asinu-backend',
    version: 1,
    tenant_id: tenantId,
    payload: { task_id: taskId, app_user_id: userId, action: 'presence' },
  }, eventId).catch(() => {
    // The messages endpoint still exposes the authoritative snapshot on refresh.
  });
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
    return { userId: String(userId), claims: payload };
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
    socket.authPool = pool;
    socket.authClaims = request.doctorChatAuth.claims;
    const url = new URL(request.url || CHAT_PATH, `http://${request.headers.host || 'localhost'}`);
    const tenantId = String(url.searchParams.get('tenant_id') || '').trim();
    const taskId = String(url.searchParams.get('task_id') || '').trim();
    const key = taskKey(tenantId, taskId);
    const clients = connections.get(key) || new Set();
    socket.connectedAt = Date.now();
    socket.lastPongAt = socket.connectedAt;
    clients.add(socket);
    connections.set(key, clients);
    const userId = request.doctorChatAuth.userId;
    if (clients.size === 1) refreshPatientPresence(tenantId, taskId, userId);

    let alive = true;
    const heartbeat = setInterval(async () => {
      if (!alive) {
        socket.terminate();
        return;
      }
      try {
        if (!(await isSessionCurrent(pool, socket.authClaims))) {
          socket.close(1008, 'Session expired');
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        alive = false;
        socket.ping();
      } catch {
        socket.close(1011, 'Authentication unavailable');
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
    socket.on('pong', () => {
      alive = true;
      socket.lastPongAt = Date.now();
    });
    send(socket, 'chat.ready', { transport: 'websocket', task_id: taskId });
    socket.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(socket);
      if (!clients.size) {
        connections.delete(key);
        refreshPatientPresence(tenantId, taskId, userId);
      }
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
    void isSessionCurrent(pool, auth.claims)
      .then((current) => current && ownsTask(pool, tenantId, taskId, auth.userId))
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
  chatPresence,
  readDoctorPresence,
  recordDoctorPresence,
  updateDoctorPresence,
};
