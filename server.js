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
const { authenticateJWT } = require('./src/middleware/auth');

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

const ESCALATION_WINDOW_MINUTES = Number(process.env.CARE_PULSE_ESCALATION_MINUTES || 20);
const ESCALATION_POLL_MS = Number(process.env.CARE_PULSE_ESCALATION_POLL_MS || 60 * 1000);
let escalationRunning = false;

async function processCarePulseEscalations() {
  if (escalationRunning) return;
  escalationRunning = true;
  try {
    await pool.query(
      `UPDATE logs_common c
       SET metadata = COALESCE(c.metadata, '{}'::jsonb)
         || jsonb_build_object('requires_immediate_action', true, 'escalated_at', NOW())
       FROM care_pulse_logs p
       WHERE p.log_id = c.id
         AND c.log_type = 'care_pulse'
         AND p.status = 'EMERGENCY'
         AND COALESCE(c.metadata->>'requires_immediate_action', 'false') = 'false'
         AND COALESCE(c.occurred_at, c.created_at) <= NOW() - INTERVAL '${ESCALATION_WINDOW_MINUTES} minutes'
         AND NOT EXISTS (
           SELECT 1
           FROM logs_common r
           JOIN care_pulse_logs rp ON rp.log_id = r.id
           WHERE r.user_id = c.user_id
             AND r.log_type = 'care_pulse'
             AND COALESCE(r.occurred_at, r.created_at) > COALESCE(c.occurred_at, c.created_at)
             AND COALESCE(r.occurred_at, r.created_at) <= COALESCE(c.occurred_at, c.created_at) + INTERVAL '${ESCALATION_WINDOW_MINUTES} minutes'
         )`
    );
  } catch (err) {
    console.error('Failed to process care pulse escalations:', err);
  } finally {
    escalationRunning = false;
  }
}

app.get('/api/mobile/logs/recent', authenticateJWT, async (req, res, next) => {
  const type = req.query.type;
  if (type && type !== 'care_pulse') {
    return next();
  }
  if (!type) {
    return next();
  }

  const limitRaw = Number(req.query.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  try {
    const result = await pool.query(
      `SELECT c.id, c.log_type, c.occurred_at, c.source, c.note, c.metadata, c.created_at,
              p.status, p.sub_status, p.trigger_source, p.escalation_sent, p.silence_count
       FROM logs_common c
       JOIN care_pulse_logs p ON p.log_id = c.id
       WHERE c.user_id = $1 AND c.log_type = 'care_pulse'
       ORDER BY c.occurred_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );

    const logs = result.rows.map((row) => {
      const detail = {
        status: row.status,
        sub_status: row.sub_status,
        trigger_source: row.trigger_source,
        escalation_sent: row.escalation_sent,
        silence_count: row.silence_count,
      };
      return {
        id: row.id,
        log_type: row.log_type,
        occurred_at: row.occurred_at,
        source: row.source,
        note: row.note,
        metadata: row.metadata,
        created_at: row.created_at,
        detail,
      };
    });

    return res.status(200).json({ ok: true, logs });
  } catch (err) {
    console.error('Failed to fetch recent care pulse logs:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.use('/api/auth', authRoutes(pool));
app.use('/api/mobile', mobileRoutes(pool));

// Start server after DB init
app.listen(PORT, () => {
  setInterval(processCarePulseEscalations, ESCALATION_POLL_MS);
  console.log(`Server running on port ${PORT}`);
});
