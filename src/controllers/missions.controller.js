const { getMissions } = require('../services/missions.service');

async function getMissionsHandler(pool, req, res) {
  if (req.query?.user_id && Number(req.query.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ ok: false, error: 'ID người dùng không khớp' });
  }

  try {
    const missions = await getMissions(pool, req.user.id);
    return res.status(200).json({ ok: true, missions });
  } catch (err) {
    console.error('missions fetch failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function getMissionHistoryHandler(pool, req, res) {
  try {
    const { days = 30 } = req.query;
    const result = await pool.query(
      `SELECT 
        mission_key, 
        completed_date, 
        progress, 
        goal,
        created_at
      FROM mission_history
      WHERE user_id = $1
        AND completed_date >= CURRENT_DATE - $2::integer
      ORDER BY completed_date DESC, mission_key ASC`,
      [req.user.id, days]
    );
    
    return res.status(200).json({ 
      ok: true, 
      history: result.rows 
    });
  } catch (err) {
    console.error('mission history fetch failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

async function getMissionStatsHandler(pool, req, res) {
  try {
    const result = await pool.query(
      `SELECT 
        mission_key,
        COUNT(*) as total_completions,
        MAX(completed_date) as last_completed,
        MIN(completed_date) as first_completed
      FROM mission_history
      WHERE user_id = $1
      GROUP BY mission_key
      ORDER BY mission_key ASC`,
      [req.user.id]
    );
    
    return res.status(200).json({ 
      ok: true, 
      stats: result.rows 
    });
  } catch (err) {
    console.error('mission stats fetch failed:', err);
    return res.status(500).json({ ok: false, error: 'Lỗi server' });
  }
}

module.exports = { 
  getMissionsHandler,
  getMissionHistoryHandler,
  getMissionStatsHandler
};
