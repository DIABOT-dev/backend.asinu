require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./src/lib/logger');
const { createPool } = require('./src/lib/db');
const { initSentry, sentryRequestHandler, sentryErrorHandler } = require('./src/lib/sentry');
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
const langMiddleware = require('./src/middleware/lang.middleware');
const { getRedis } = require('./src/lib/redis');
const { startScheduler } = require('./src/scheduler');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const path = require('path');
const app = express();
app.set('trust proxy', 1);

// Sentry MUST be initialized before other middleware so it can capture them
initSentry();
app.use(sentryRequestHandler());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'"],
      'script-src-attr': ["'none'"],
    },
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- OPS HEALTH CHECK ---
// Public endpoints: minimal info to avoid stack fingerprinting
app.get('/api/healthz', async (_req, res) => {
  // Still probe redis so container orchestrators get an accurate liveness signal,
  // but never expose the result to the response body.
  try { await getRedis().ping(); } catch { /* ignore */ }
  res.status(200).json({ status: 'ok' });
});
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Detailed health requires HEALTH_CHECK_TOKEN header (set as env)
app.get('/api/healthz/detailed', async (req, res) => {
  const token = req.headers['x-health-token'];
  if (!process.env.HEALTH_CHECK_TOKEN || token !== process.env.HEALTH_CHECK_TOKEN) {
    return res.status(404).json({ status: 'not_found' });
  }
  let redisOk = false;
  try { redisOk = (await getRedis().ping()) === 'PONG'; } catch { /* ignore */ }
  res.status(200).json({
    status: 'ok',
    redis: redisOk ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
// -------------------------

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

// Postgres connection pool (instrumented with slow-query logging)
const pool = createPool({ connectionString: DATABASE_URL });

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
app.use('/api/iap', iapRoutes(pool));
app.use('/api/asinu-brain', asinuBrainRoutes(pool));

// Sentry error handler must run BEFORE our custom one
app.use(sentryErrorHandler());

// Global error handler — suppress client-aborted requests
app.use((err, req, res, _next) => {
  if (err.type === 'request.aborted' || err.code === 'ECONNRESET') return;
  logger.error('unhandled_error', { err, path: req?.path, method: req?.method });
  if (!res.headersSent) {
    const code = err.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    res.status(err.statusCode || 500).json({ ok: false, error: 'Internal server error', code });
  }
});

// Connect Redis then start server
getRedis().connect().catch((err) => {
  logger.warn('redis.connect_failed', { err });
});

app.listen(PORT, () => {
  logger.info('server.listening', { port: PORT });
});

startScheduler(pool);
