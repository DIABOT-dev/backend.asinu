require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const authRoutes = require('./src/routes/auth.routes');
const mobileRoutes = require('./src/routes/mobile.routes');
const carePulseRoutes = require('./src/routes/carePulse.routes');
const careCircleRoutes = require('./src/routes/careCircle.routes');
const wellnessRoutes = require('./src/routes/wellness.routes');
const healthRoutes = require('./src/routes/health.routes');
const notificationRoutes = require('./src/routes/notifications.routes');
const asinuBrainRoutes = require('./asinu-brain-extension/routes/asinuBrain.routes');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const app = express();
app.use(express.json());
app.use(helmet());

// --- OPS HEALTH CHECK (INJECTED) ---
app.get('/api/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
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
  message: { ok: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for health checks
  skip: (req) => req.path === '/healthz' || req.path === '/api/healthz'
});

// Stricter rate limiting for auth endpoints (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 50 auth requests per 15 min
  message: { ok: false, error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);

// Postgres connection pool
const pool = new Pool({ connectionString: DATABASE_URL });

app.use('/api/auth', authLimiter, authRoutes(pool));
app.use('/api/mobile', mobileRoutes(pool));
app.use('/api/care-pulse', carePulseRoutes(pool));
app.use('/api/care-circle', careCircleRoutes(pool));
app.use('/api/wellness', wellnessRoutes(pool));
app.use('/api/health', healthRoutes(pool));
app.use('/api/notifications', notificationRoutes(pool));
app.use('/api/asinu-brain', asinuBrainRoutes(pool));

// Start server after DB init
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
