const { answerSchema, emergencySchema } = require('../validation/asinuBrain.schemas');
const { getNextState, submitAnswer, getTimeline, postEmergency } = require('../services/asinuBrain.service');

async function getNextHandler(pool, req, res) {
  try {
    const result = await getNextState(pool, req.userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('asinu-brain next failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function postAnswerHandler(pool, req, res) {
  if (req.body?.user_id) {
    return res.status(400).json({ ok: false, error: 'user_id is not allowed' });
  }
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }

  try {
    const result = await submitAnswer(pool, req.userId, parsed.data);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('asinu-brain answer failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function getTimelineHandler(pool, req, res) {
  try {
    const timeline = await getTimeline(pool, req.userId);
    return res.status(200).json({ ok: true, timeline });
  } catch (err) {
    console.error('asinu-brain timeline failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

async function postEmergencyHandler(pool, req, res) {
  if (req.body?.user_id) {
    return res.status(400).json({ ok: false, error: 'user_id is not allowed' });
  }
  const parsed = emergencySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }

  try {
    const result = await postEmergency(pool, req.userId, parsed.data);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('asinu-brain emergency failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = {
  getNextHandler,
  postAnswerHandler,
  getTimelineHandler,
  postEmergencyHandler
};
