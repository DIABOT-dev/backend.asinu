'use strict';
const assert = require('node:assert/strict');
const { env } = require('./dist/config/env');
const { createPool } = require('./dist/db/pool');

async function main() {
  assert.equal(process.argv[2], 'inspect');
  const pool = createPool(env.databaseUrl);
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const doctors = (await db.query(`SELECT a.id, a.tenant_id, a.full_name, a.role, a.status,
      p.specialties, p.remote_care_allowed
      FROM doctor_accounts a LEFT JOIN doctor_profiles p ON p.account_id=a.id
      WHERE lower(a.email)=lower($1)`, ['ducytcg123456@gmail.com'])).rows;
    assert.equal(doctors.length, 1);
    const doctor = doctors[0];
    const sessions = (await db.query(`SELECT id,session_code,state,accepting_new,current_load,
      capacity_max,planned_end_at FROM doctor_sessions
      WHERE doctor_id=$1 AND state IN ('online','stopping','closing') ORDER BY start_at DESC`, [doctor.id])).rows;
    const tasks = (await db.query(`SELECT status,COUNT(*)::int AS count FROM doctor_tasks
      WHERE doctor_id=$1 GROUP BY status ORDER BY status`, [doctor.id])).rows;
    const queued = (await db.query(`SELECT COUNT(*)::int AS count FROM doctor_tasks
      WHERE tenant_id=$1 AND status IN ('new','queued')`, [doctor.tenant_id])).rows[0].count;
    console.log(JSON.stringify({doctor,sessions,tasks,queuedInTenant:queued}));
    await db.query('ROLLBACK');
  } finally {
    db.release();
    await pool.end();
  }
}
main().catch(error => {
  console.error(JSON.stringify({error:error.code || error.name,message:error.message}));
  process.exitCode = 1;
});
