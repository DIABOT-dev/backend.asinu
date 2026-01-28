const { evaluateAndApplyEvent, getState } = require('../services/carePulseAps');
const { carePulseEventSchema, escalationAckSchema } = require('../validation/schemas');

async function postEvent(pool, req, res) {
  try {
    const parsed = carePulseEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
    }

    const result = await evaluateAndApplyEvent(pool, {
      userId: req.user.id,
      event: parsed.data,
      now: new Date()
    });

    return res.status(200).json({
      ok: true,
      state: result.state,
      aps: result.aps,
      tier: result.tier,
      reasons: result.reasons,
      actions: result.actions,
      state_name: result.state.currentStatus
    });
  } catch (err) {
    console.error('care-pulse event failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function getStateHandler(pool, req, res) {
  try {
    const state = await getState(pool, req.user.id);
    return res.status(200).json({
      ok: true,
      state,
      aps: state.aps,
      tier: state.tier,
      reasons: state.reasons,
      state_name: state.currentStatus
    });
  } catch (err) {
    console.error('care-pulse state failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function ackEscalation(pool, req, res) {
  const parsed = escalationAckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }
  const escalationId = parsed.data.escalation_id;

  try {
    const escalationResult = await pool.query(
      'SELECT id, user_id, status FROM care_pulse_escalations WHERE id = $1',
      [escalationId]
    );

    if (escalationResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Escalation not found' });
    }

    const escalation = escalationResult.rows[0];
    const permission = await pool.query(
      `SELECT id
       FROM user_connections
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND COALESCE((permissions->>'can_ack_escalation')::boolean, false) = true`,
      [escalation.user_id, req.user.id]
    );

    if (permission.rows.length === 0) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    if (escalation.status === 'acknowledged') {
      return res.status(200).json({ ok: true, status: escalation.status });
    }

    await pool.query(
      `UPDATE care_pulse_escalations
       SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2
       WHERE id = $1`,
      [escalationId, req.user.id]
    );

    return res.status(200).json({ ok: true, status: 'acknowledged' });
  } catch (err) {
    console.error('care-pulse ack failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = {
  postEvent,
  getStateHandler,
  ackEscalation
};
