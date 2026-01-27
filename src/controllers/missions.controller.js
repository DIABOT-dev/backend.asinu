const { getMissions } = require('../services/missionsService');

async function getMissionsHandler(pool, req, res) {
  if (req.query?.user_id && Number(req.query.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'User mismatch' });
  }

  try {
    const missions = await getMissions(pool, req.user.id);
    return res.status(200).json({ ok: true, missions });
  } catch (err) {
    console.error('missions fetch failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = { getMissionsHandler };
