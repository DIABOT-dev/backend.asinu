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

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Postgres connection pool
const pool = new Pool({ connectionString: DATABASE_URL });

app.use('/api/auth', authRoutes(pool));
app.use('/api/mobile', mobileRoutes(pool));
app.use('/api/care-pulse', carePulseRoutes(pool));
app.use('/api/care-circle', careCircleRoutes(pool));
app.use('/api/wellness', wellnessRoutes(pool));

// Start server after DB init
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
