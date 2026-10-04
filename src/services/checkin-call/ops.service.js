'use strict';

const { AUDIO_KEYS } = require('./audio.service');

async function getMetrics(pool) {
  const [episodes, attempts, deliveries, queue, audio] = await Promise.all([
    pool.query(
      `SELECT state, COUNT(*)::integer AS count
         FROM checkin_call_episodes
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY state`
    ),
    pool.query(
      `SELECT state, COUNT(*)::integer AS count
         FROM checkin_call_attempts
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY state`
    ),
    pool.query(
      `SELECT state, COUNT(*)::integer AS count
         FROM checkin_call_deliveries
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY state`
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE next_action_at <= NOW())::integer AS due_episodes,
         COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(next_action_at)) FILTER (WHERE next_action_at <= NOW()), 0)::integer AS oldest_due_seconds,
         (SELECT COUNT(*)::integer FROM checkin_call_deliveries WHERE state = 'SENDING' AND updated_at < NOW() - INTERVAL '2 minutes') AS stale_deliveries
       FROM checkin_call_episodes
      WHERE state NOT IN ('RESOLVED','EXHAUSTED','EXHAUSTED_MILD','EXHAUSTED_URGENT','CANCELLED','URGENT_ACKNOWLEDGED')`
    ),
    pool.query('SELECT COUNT(*)::integer AS count, MAX(created_at) AS newest_at FROM checkin_call_audio'),
  ]);
  const toCounts = (rows) =>
    Object.fromEntries(rows.map((row) => [row.state, Number(row.count || 0)]));
  const expectedAudioAssets = AUDIO_KEYS.length * (process.env.VIENEU_VOICE_EN ? 2 : 1);
  const cachedAudioAssets = Number(audio.rows[0]?.count || 0);

  return {
    generated_at: new Date().toISOString(),
    episodes_24h: toCounts(episodes.rows),
    attempts_24h: toCounts(attempts.rows),
    deliveries_24h: toCounts(deliveries.rows),
    queue: queue.rows[0] || { due_episodes: 0, oldest_due_seconds: 0, stale_deliveries: 0 },
    audio_cache: {
      cached: cachedAudioAssets,
      expected: expectedAudioAssets,
      ready: cachedAudioAssets >= expectedAudioAssets,
      newest_at: audio.rows[0]?.newest_at || null,
    },
  };
}

async function listExhausted(pool, requestedLimit) {
  const limit = Math.max(1, Math.min(Number(requestedLimit) || 20, 100));
  const { rows } = await pool.query(
    `SELECT id, user_id, state, severity, exhausted_at, created_at,
            COALESCE(config->>'test_mode', 'false')::boolean AS is_test_fixture
       FROM checkin_call_episodes
      WHERE state IN ('EXHAUSTED','EXHAUSTED_MILD','EXHAUSTED_URGENT')
      ORDER BY exhausted_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getEpisodeTimeline(pool, episodeId) {
  const { rows } = await pool.query(
    `SELECT id, attempt_id, actor_user_id, event, detail, created_at
       FROM checkin_call_events
      WHERE episode_id = $1
      ORDER BY created_at, id`,
    [episodeId]
  );
  return rows;
}

module.exports = { getMetrics, listExhausted, getEpisodeTimeline };
