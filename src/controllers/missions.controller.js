const { getMissions, getMissionHistory, getMissionStats } = require('../services/missions.service');

/**
 * GET /api/missions
 * Get user's current missions
 */
async function getMissionsHandler(pool, req, res) {
  if (req.query?.user_id && Number(req.query.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'ID người dùng không khớp' });
  }

  try {
    const missions = await getMissions(pool, req.user.id);
    return res.status(200).json({ ok: true, missions });
  } catch (err) {
    console.error('[missions.controller] getMissionsHandler failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

/**
 * GET /api/missions/history
 * Get mission history for past N days
 */
async function getMissionHistoryHandler(pool, req, res) {
  const { days = 30 } = req.query;
  
  const result = await getMissionHistory(pool, req.user.id, Number(days));
  
  if (!result.ok) {
    return res.status(500).json(result);
  }
  
  return res.status(200).json(result);
}

/**
 * GET /api/missions/stats
 * Get mission completion statistics
 */
async function getMissionStatsHandler(pool, req, res) {
  const result = await getMissionStats(pool, req.user.id);
  
  if (!result.ok) {
    return res.status(500).json(result);
  }
  
  return res.status(200).json(result);
}

module.exports = { 
  getMissionsHandler,
  getMissionHistoryHandler,
  getMissionStatsHandler
};
