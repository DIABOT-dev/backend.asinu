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

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const path = require('path');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet());
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
app.use('/api/test', testRoutes(pool)); // Public test API - no auth required

// Connect Redis then start server
getRedis().connect().catch((err) => {
  console.warn('[Redis] Could not connect — running without cache:', err.message);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Cleanup old chat histories every 24 hours
setInterval(async () => {
  try {
    await pool.query('SELECT cleanup_chat_histories()');
    console.log('[cleanup] Chat history cleanup completed');
  } catch (err) {
    console.warn('[cleanup] Chat history cleanup failed:', err?.message);
  }
}, 24 * 60 * 60 * 1000);
