// Copilot:
// Create an Express.js server skeleton for an MVP API.
// Requirements:
// - Use express, helmet, express-rate-limit, jsonwebtoken, pg
// - Load env variables (PORT, DATABASE_URL, JWT_SECRET)
// - Connect to Postgres using pg Pool
// - Auto-create minimal tables: users, health_logs, chat_logs (if not exist)
// - Define empty route handlers (TODO) for:
//   POST /api/auth/verify
//   POST /api/mobile/logs
//   POST /api/mobile/chat
//   DELETE /api/auth/me
// - Add JWT auth middleware skeleton
// - Do NOT implement business logic yet
// - Focus on clean structure and comments

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const authRoutes = require('./src/routes/auth.routes');
const mobileRoutes = require('./src/routes/mobile.routes');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const app = express();
app.use(express.json());
app.use(helmet());

// --- OPS HEALTH CHECK (INJECTED) ---
app.get("/api/healthz", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});
app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});
// ----------------------------------

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Postgres connection pool
const pool = new Pool({ connectionString: DATABASE_URL });

app.use('/api/auth', authRoutes(pool));
app.use('/api/mobile', mobileRoutes(pool));

// Start server after DB init
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
