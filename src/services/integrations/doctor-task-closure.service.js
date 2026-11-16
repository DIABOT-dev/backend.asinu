'use strict';
// Safe on retries and called on lifecycle delivery as well as patient cancellation.
async function stopPatientTaskIvr(pool, userId, tenantId, taskId) {
  await pool.query(
    `WITH sessions AS (
    UPDATE doctor_ivr_sessions SET status='cancelled',updated_at=NOW()
    WHERE user_id=$1 AND tenant_id=$2 AND task_id=$3
      AND status IN ('draft','sent','in_progress','completed') RETURNING id
  ) UPDATE doctor_ivr_call_attempts SET status='cancelled',finished_at=NOW()
    WHERE session_id IN (SELECT id FROM sessions) AND status IN ('queued','ringing','dispatching')`,
    [userId, tenantId, taskId]
  );
}
module.exports = { stopPatientTaskIvr };
