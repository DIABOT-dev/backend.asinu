require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { t, getLang } = require('./src/i18n');
const authRoutes = require('./src/routes/auth.routes');
const mobileRoutes = require('./src/routes/mobile.routes');
const missionsRoutes = require('./src/routes/missions.routes');
const carePulseRoutes = require('./src/routes/carePulse.routes');
const careCircleRoutes = require('./src/routes/careCircle.routes');
const wellnessRoutes = require('./src/routes/wellness.routes');
const healthRoutes = require('./src/routes/health.routes');
const notificationRoutes = require('./src/routes/notifications.routes');
const paymentRoutes = require('./src/routes/payment.routes');
const subscriptionRoutes = require('./src/routes/subscription.routes');
const voiceRoutes = require('./src/routes/voice.routes');
const logsRoutes = require('./src/routes/logs.routes');
const asinuBrainRoutes = require('./asinu-brain-extension/routes/asinuBrain.routes');
const testRoutes = require('./asinu-brain-extension/routes/test.routes');
const langMiddleware = require('./src/middleware/lang.middleware');
const { getRedis } = require('./src/lib/redis');
const { runBasicNotifications } = require('./src/services/notification/basic.notification.service');
const { runNightlyCycle } = require('./src/services/checkin/rnd-cycle.service');
const { updateAllSegments } = require('./src/services/profile/lifecycle.service');
const { runDailyLifecycleNotifications } = require('./src/services/notification/lifecycle.notification.service');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const path = require('path');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Disable CSP for test UI, keep helmet for other routes
app.use('/api/test/chat-ui', (req, res, next) => next());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- OPS HEALTH CHECK (INJECTED) ---
app.get('/api/healthz', async (req, res) => {
  let redisOk = false;
  try { redisOk = (await getRedis().ping()) === 'PONG'; } catch { /* ignore */ }
  res.status(200).json({ status: 'ok', redis: redisOk ? 'connected' : 'disconnected', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
// ----------------------------------

// Rate limiting - relaxed for mobile app usage
// 1000 requests per 15 minutes per IP (more reasonable for mobile apps with multiple API calls)
const generalLimiter = rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 1000,
  message: { ok: false, error: t('error.too_many_requests', getLang(null)) },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for health checks
  skip: (req) => req.path === '/healthz' || req.path === '/api/healthz'
});

// Stricter rate limiting for auth endpoints (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 50 auth requests per 15 min
  message: { ok: false, error: t('error.too_many_auth_attempts', getLang(null)) },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);
app.use(langMiddleware);

// Postgres connection pool
const pool = new Pool({ connectionString: DATABASE_URL });

app.use('/api/auth', authLimiter, authRoutes(pool));
app.use('/api/mobile', mobileRoutes(pool));
app.use('/api/missions', missionsRoutes(pool));
app.use('/api/care-pulse', carePulseRoutes(pool));
app.use('/api/care-circle', careCircleRoutes(pool));
app.use('/api/wellness', wellnessRoutes(pool));
app.use('/api/health', healthRoutes(pool));
app.use('/api/notifications', notificationRoutes(pool));
app.use('/api/payments', paymentRoutes(pool));
app.use('/api/subscriptions', subscriptionRoutes(pool));
app.use('/api/voice', voiceRoutes(pool));
app.use('/api/logs', logsRoutes(pool));
app.use('/api/asinu-brain', asinuBrainRoutes(pool));
// Test routes — chỉ enable khi không phải production
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/test', testRoutes(pool));
}

// Global error handler — suppress client-aborted requests
app.use((err, req, res, next) => {
  if (err.type === 'request.aborted' || err.code === 'ECONNRESET') return;
  console.error('[Server]', err.message);
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal server error' });
});

// Connect Redis then start server
getRedis().connect().catch((err) => {
  console.warn('[Redis] Could not connect — running without cache:', err.message);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Per-minute notification cron — fires at exact HH:MM configured by each user
function scheduleNotifications() {
  let isRunning = false;
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    const tick = async () => {
      if (isRunning) {
        console.log('[cron] skipped — previous tick still running');
        return;
      }
      isRunning = true;
      try {
        const result = await runBasicNotifications(pool);
        if (result.totalSent > 0)
          console.log(`[cron] sent=${result.totalSent} at ${result.hour}:${String(result.minute).padStart(2,'0')}`);
      } catch (err) {
        console.warn('[cron] runBasicNotifications failed:', err?.message);
      } finally {
        isRunning = false;
      }
    };
    tick();
    setInterval(tick, 60 * 1000);
  }, msToNextMinute);
}
scheduleNotifications();

// Cleanup old chat histories every 24 hours
setInterval(async () => {
  try {
    await pool.query('SELECT cleanup_chat_histories()');
    console.log('[cleanup] Chat history cleanup completed');
  } catch (err) {
    console.warn('[cleanup] Chat history cleanup failed:', err?.message);
  }
}, 24 * 60 * 60 * 1000);

// Lifecycle segment update — runs at 1:00 AM Vietnam time (before R&D cycle)
function scheduleLifecycleUpdate() {
  const checkAndRun = async () => {
    const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    if (vnNow.getHours() === 1 && vnNow.getMinutes() < 5) {
      try {
        console.log('[Lifecycle] Running daily segment update...');
        const stats = await updateAllSegments(pool);
        console.log('[Lifecycle] Update completed:', stats);
      } catch (err) {
        console.error('[Lifecycle] Update failed:', err?.message);
      }
    }
  };
  setInterval(checkAndRun, 5 * 60 * 1000);
}
scheduleLifecycleUpdate();

// R&D Cycle — runs at 2:00 AM Vietnam time (UTC+7 = 19:00 UTC previous day)
// Processes fallback logs, updates clusters, optimizes scripts
function scheduleRndCycle() {
  const checkAndRun = async () => {
    const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    if (vnNow.getHours() === 2 && vnNow.getMinutes() < 5) {
      try {
        console.log('[R&D] Starting nightly cycle...');
        const stats = await runNightlyCycle(pool);
        console.log('[R&D] Cycle completed:', stats);
      } catch (err) {
        console.error('[R&D] Cycle failed:', err?.message);
      }
    }
  };
  // Check every 5 minutes
  setInterval(checkAndRun, 5 * 60 * 1000);
}
scheduleRndCycle();

// Daily lifecycle notifications — 7:00 AM Vietnam time
// (subscription expiring/expired, weekly summary on Sunday, profile incomplete)
function scheduleLifecycleNotifications() {
  const checkAndRun = async () => {
    const vnNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    if (vnNow.getHours() === 7 && vnNow.getMinutes() < 5) {
      try {
        console.log('[Lifecycle-Notif] Running daily notifications...');
        const stats = await runDailyLifecycleNotifications(pool, { dayOfWeek: vnNow.getDay() });
        console.log('[Lifecycle-Notif] Done:', JSON.stringify(stats));
      } catch (err) {
        console.error('[Lifecycle-Notif] Failed:', err?.message);
      }
    }
  };
  setInterval(checkAndRun, 5 * 60 * 1000);
}
scheduleLifecycleNotifications();
