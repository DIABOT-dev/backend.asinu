/**
 * CarePulse Controller
 * HTTP handlers for care pulse APS endpoints
 */

const { evaluateAndApplyEvent, getState, acknowledgeEscalation } = require('../services/carePulse.aps.service');
const { carePulseEventSchema, escalationAckSchema } = require('../validation/validation.schemas');

/**
 * POST /api/care-pulse/events
 * Process a care pulse event
 */
async function postEvent(pool, req, res) {
  // Validate request
  const parsed = carePulseEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ', details: parsed.error.issues });
  }

  try {
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
    console.error('[carePulse.controller] postEvent failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

/**
 * GET /api/care-pulse/state
 * Get current care pulse state
 */
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
    console.error('[carePulse.controller] getStateHandler failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

/**
 * POST /api/care-pulse/escalations/ack
 * Acknowledge an escalation
 */
async function ackEscalation(pool, req, res) {
  // Validate request
  const parsed = escalationAckSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ', details: parsed.error.issues });
  }

  // Call service
  const result = await acknowledgeEscalation(pool, parsed.data.escalation_id, req.user.id);

  if (!result.ok) {
    const statusCode = result.statusCode || 400;
    return res.status(statusCode).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, status: result.status });
}

module.exports = {
  postEvent,
  getStateHandler,
  ackEscalation
};
