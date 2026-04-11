'use strict';

/**
 * R&D Cycle Service — Nightly AI Batch Processing
 *
 * Chạy mỗi đêm 2:00 AM, xử lý batch:
 *   1. Gom data check-in trong ngày
 *   2. Cập nhật tần suất triệu chứng → clusters
 *   3. Xử lý triệu chứng mới (fallback logs) → AI gắn nhãn → tạo cluster mới
 *   4. Tối ưu script cho ngày mai
 *   5. Tạo báo cáo tuần (nếu đến hạn)
 *
 * AI chỉ gọi ở đây — KHÔNG gọi trong luồng check-in ban ngày.
 * Estimated: 100-500 AI calls/đêm cho toàn bộ users.
 */

const OpenAI = require('openai');
const { getPendingFallbacks, markFallbackProcessed } = require('./fallback.service');
const { addCluster, updateClusterStats, generateScriptForCluster, toClusterKey } = require('./script.service');
const { updateSymptomFrequency } = require('./symptom-tracker.service');
const { getActiveUserIds, updateAllSegments, getUsersBySegment } = require('../profile/lifecycle.service');

// Phase 6 #16: Priority compute — timeout limit để tránh cycle chạy quá lâu
const MAX_CYCLE_MS = parseInt(process.env.RND_MAX_CYCLE_MS || '1800000', 10); // default 30 phút

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

const RND_MODEL = process.env.RND_CYCLE_MODEL || 'gpt-4o-mini';

// ─── Main R&D Cycle ─────────────────────────────────────────────────────────

/**
 * Run the nightly R&D cycle.
 * Called by cron job at 2:00 AM Vietnam time.
 *
 * @param {object} pool
 * @returns {Promise<object>} cycle stats
 */
async function runNightlyCycle(pool) {
  const cycleStart = new Date();
  let cycleLogId = null;

  try {
    // Create cycle log
    const { rows } = await pool.query(
      `INSERT INTO rnd_cycle_logs (started_at) VALUES (NOW()) RETURNING id`
    );
    cycleLogId = rows[0].id;

    const stats = {
      usersProcessed: 0,
      usersSkipped: 0,
      activeProcessed: 0,
      semiActiveProcessed: 0,
      semiActiveSkippedTimeout: 0,
      fallbacksProcessed: 0,
      clustersCreated: 0,
      clustersUpdated: 0,
      scriptsRegenerated: 0,
      scriptsReused: 0,
      aiCallsMade: 0,
      elapsedMs: 0,
    };

    // Step 0: Update lifecycle segments
    const lifecycleStats = await updateAllSegments(pool);
    stats.usersSkipped = (lifecycleStats.inactive || 0) + (lifecycleStats.churned || 0);

    // Phase 6 #16: Get active vs semi_active separately for priority processing
    const [activeUsers, semiActiveUsers] = await Promise.all([
      getUsersBySegment(pool, 'active'),
      getUsersBySegment(pool, 'semi_active'),
    ]);
    const activeIds = activeUsers.map(u => u.user_id);
    const semiActiveIds = semiActiveUsers.map(u => u.user_id);

    console.log(`[R&D] Priority: ${activeIds.length} active, ${semiActiveIds.length} semi_active, ${stats.usersSkipped} skipped`);

    // ─── PRIORITY 1: Active users (full processing, no timeout) ──────────
    const activeFallback = await processFallbackLogs(pool, activeIds);
    stats.fallbacksProcessed += activeFallback.processed;
    stats.clustersCreated += activeFallback.clustersCreated;
    stats.aiCallsMade += activeFallback.aiCalls;

    const activeCluster = await updateAllClusterFrequencies(pool, activeIds);
    stats.activeProcessed = activeCluster.usersProcessed;
    stats.clustersUpdated += activeCluster.clustersUpdated;

    const activeScript = await optimizeScripts(pool, activeIds);
    stats.scriptsRegenerated += activeScript.regenerated;

    // ─── PRIORITY 2: Semi-active users (only if time remaining) ──────────
    const elapsedAfterActive = Date.now() - cycleStart.getTime();
    if (elapsedAfterActive < MAX_CYCLE_MS) {
      const remainingMs = MAX_CYCLE_MS - elapsedAfterActive;
      console.log(`[R&D] Active done in ${elapsedAfterActive}ms — ${Math.round(remainingMs/1000)}s remaining for semi_active`);

      // Process semi_active with periodic timeout check
      const semiResult = await processSemiActiveWithTimeout(
        pool, semiActiveIds, cycleStart
      );
      stats.semiActiveProcessed = semiResult.usersProcessed;
      stats.semiActiveSkippedTimeout = semiResult.skipped;
      stats.fallbacksProcessed += semiResult.fallbacksProcessed;
      stats.clustersCreated += semiResult.clustersCreated;
      stats.clustersUpdated += semiResult.clustersUpdated;
      stats.scriptsRegenerated += semiResult.scriptsRegenerated;
      stats.aiCallsMade += semiResult.aiCalls;
    } else {
      console.log(`[R&D] ⚠️ TIMEOUT after active processing — skipping all ${semiActiveIds.length} semi_active users`);
      stats.semiActiveSkippedTimeout = semiActiveIds.length;
    }

    stats.usersProcessed = stats.activeProcessed + stats.semiActiveProcessed;
    stats.elapsedMs = Date.now() - cycleStart.getTime();

    // Update cycle log với metrics chi tiết
    await pool.query(
      `UPDATE rnd_cycle_logs SET
         completed_at = NOW(),
         status = 'completed',
         users_processed = $2,
         fallbacks_processed = $3,
         clusters_created = $4,
         clusters_updated = $5,
         scripts_regenerated = $6,
         ai_calls_made = $7,
         active_processed = $8,
         semi_active_processed = $9,
         semi_active_skipped_timeout = $10,
         scripts_reused = $11,
         elapsed_ms = $12
       WHERE id = $1`,
      [cycleLogId, stats.usersProcessed, stats.fallbacksProcessed,
       stats.clustersCreated, stats.clustersUpdated,
       stats.scriptsRegenerated, stats.aiCallsMade,
       stats.activeProcessed, stats.semiActiveProcessed,
       stats.semiActiveSkippedTimeout, stats.scriptsReused, stats.elapsedMs]
    );

    console.log(`[R&D Cycle] Completed in ${stats.elapsedMs}ms:`, stats);
    return stats;
  } catch (err) {
    console.error('[R&D Cycle] Failed:', err.message);

    if (cycleLogId) {
      await pool.query(
        `UPDATE rnd_cycle_logs SET
           completed_at = NOW(), status = 'failed', error_message = $2
         WHERE id = $1`,
        [cycleLogId, err.message]
      ).catch(() => {});
    }

    throw err;
  }
}

// ─── Phase 6 #16: Process semi-active with timeout check ────────────────────

/**
 * Process semi-active users batch-by-batch, checking timeout between batches.
 * Skip remaining users if MAX_CYCLE_MS exceeded.
 */
async function processSemiActiveWithTimeout(pool, semiActiveIds, cycleStart) {
  const result = {
    usersProcessed: 0,
    skipped: 0,
    fallbacksProcessed: 0,
    clustersCreated: 0,
    clustersUpdated: 0,
    scriptsRegenerated: 0,
    aiCalls: 0,
  };

  if (!semiActiveIds || semiActiveIds.length === 0) return result;

  // Process in small batches so timeout check is responsive
  const BATCH_SIZE = 5;
  for (let i = 0; i < semiActiveIds.length; i += BATCH_SIZE) {
    // Check timeout before each batch
    if (Date.now() - cycleStart.getTime() >= MAX_CYCLE_MS) {
      result.skipped = semiActiveIds.length - i;
      console.log(`[R&D] ⏱️ Timeout reached — skipping remaining ${result.skipped} semi_active users`);
      break;
    }

    const batch = semiActiveIds.slice(i, i + BATCH_SIZE);

    try {
      // Run pipeline on this batch
      const fb = await processFallbackLogs(pool, batch);
      result.fallbacksProcessed += fb.processed;
      result.clustersCreated += fb.clustersCreated;
      result.aiCalls += fb.aiCalls;

      const cl = await updateAllClusterFrequencies(pool, batch);
      result.usersProcessed += cl.usersProcessed;
      result.clustersUpdated += cl.clustersUpdated;

      const sc = await optimizeScripts(pool, batch);
      result.scriptsRegenerated += sc.regenerated;
    } catch (err) {
      console.warn(`[R&D] Batch failed (semi_active ${i}-${i + BATCH_SIZE}):`, err.message);
    }
  }

  return result;
}

// ─── Step 1: Process fallback logs ──────────────────────────────────────────

/**
 * Process pending fallback logs:
 *   - Group by user
 *   - AI labels each unknown symptom
 *   - Create new cluster or merge into existing
 *   - Generate script for new cluster
 */
async function processFallbackLogs(pool, activeUserIds = null) {
  // If activeUserIds is explicitly empty → skip
  if (Array.isArray(activeUserIds) && activeUserIds.length === 0) {
    return { processed: 0, clustersCreated: 0, aiCalls: 0 };
  }

  const fallbacks = await getPendingFallbacks(pool, 200);
  let processed = 0;
  let clustersCreated = 0;
  let aiCalls = 0;

  // Group by user
  const byUser = {};
  for (const fb of fallbacks) {
    if (!byUser[fb.user_id]) byUser[fb.user_id] = [];
    byUser[fb.user_id].push(fb);
  }

  for (const [userId, userFallbacks] of Object.entries(byUser)) {
    // Skip inactive/churned users
    if (activeUserIds && !activeUserIds.includes(parseInt(userId))) {
      console.log(`[R&D] Skipping fallback processing for inactive user ${userId}`);
      continue;
    }
    // Get user's existing clusters
    const { rows: existingClusters } = await pool.query(
      `SELECT cluster_key, display_name FROM problem_clusters
       WHERE user_id = $1 AND is_active = TRUE`,
      [userId]
    );

    for (const fb of userFallbacks) {
      try {
        // AI labels the unknown symptom
        const label = await labelSymptom(fb.raw_input, existingClusters);
        aiCalls++;

        if (label.matchExisting) {
          // Merge into existing cluster
          await markFallbackProcessed(
            pool, fb.id, label.label, label.clusterKey, label.confidence
          );
        } else {
          // Create new cluster
          const cluster = await addCluster(
            pool, parseInt(userId), label.clusterKey, label.displayName, 'rnd_cycle'
          );
          await markFallbackProcessed(
            pool, fb.id, label.label, label.clusterKey, label.confidence, cluster.id
          );
          clustersCreated++;
        }

        processed++;
      } catch (err) {
        console.error(`[R&D] Failed to process fallback ${fb.id}:`, err.message);
      }
    }
  }

  return { processed, clustersCreated, aiCalls };
}

/**
 * AI labels an unknown symptom.
 * Returns: { label, clusterKey, displayName, confidence, matchExisting }
 */
async function labelSymptom(rawInput, existingClusters) {
  const clusterList = existingClusters
    .map(c => `${c.cluster_key} (${c.display_name})`)
    .join(', ');

  const prompt = `Bệnh nhân nói: "${rawInput}"

Existing clusters: [${clusterList || 'chưa có'}]

Phân loại triệu chứng này. Trả về JSON:
{
  "label": "tên y khoa ngắn gọn (tiếng Việt)",
  "cluster_key": "english_snake_case",
  "display_name": "tên hiển thị tiếng Việt",
  "confidence": 0.0-1.0,
  "match_existing": "cluster_key nếu thuộc cluster có sẵn, null nếu cần tạo mới",
  "reasoning": "lý do phân loại"
}

CHỈ JSON.`;

  try {
    const response = await getClient().chat.completions.create({
      model: RND_MODEL,
      temperature: 0.1,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Bạn là bác sĩ phân loại triệu chứng. Chỉ trả về JSON.' },
        { role: 'user', content: prompt },
      ],
    });

    const raw = (response.choices?.[0]?.message?.content || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid JSON');

    const parsed = JSON.parse(match[0]);
    return {
      label: parsed.label || rawInput,
      clusterKey: parsed.cluster_key || toClusterKey(rawInput),
      displayName: parsed.display_name || rawInput,
      confidence: parsed.confidence || 0.5,
      matchExisting: parsed.match_existing || null,
    };
  } catch (err) {
    console.error('[R&D] AI labeling failed:', err.message);
    // Fallback: create a simple cluster from raw input
    return {
      label: rawInput,
      clusterKey: toClusterKey(rawInput),
      displayName: rawInput,
      confidence: 0.3,
      matchExisting: null,
    };
  }
}

// ─── Step 2: Update cluster frequencies ─────────────────────────────────────

/**
 * Update frequency stats for all active clusters across all users.
 */
async function updateAllClusterFrequencies(pool, activeUserIds = null) {
  let usersProcessed = 0;
  let clustersUpdated = 0;

  // If activeUserIds is explicitly an empty array → no users to process
  if (Array.isArray(activeUserIds) && activeUserIds.length === 0) {
    return { usersProcessed: 0, clustersUpdated: 0 };
  }

  // Get users with active clusters (filtered by lifecycle)
  let query = `SELECT DISTINCT user_id FROM problem_clusters WHERE is_active = TRUE`;
  const params = [];
  if (activeUserIds && activeUserIds.length > 0) {
    query += ` AND user_id = ANY($1)`;
    params.push(activeUserIds);
  }
  const { rows: users } = await pool.query(query, params);

  for (const { user_id } of users) {
    try {
      // Update symptom_frequency table first
      await updateSymptomFrequency(pool, user_id);

      // Sync cluster stats from symptom_frequency
      const { rows: frequencies } = await pool.query(
        `SELECT sf.symptom_name, sf.count_7d, sf.count_30d, sf.trend, sf.last_occurred
         FROM symptom_frequency sf
         WHERE sf.user_id = $1 AND sf.count_30d > 0`,
        [user_id]
      );

      const { rows: clusters } = await pool.query(
        `SELECT * FROM problem_clusters WHERE user_id = $1 AND is_active = TRUE`,
        [user_id]
      );

      for (const cluster of clusters) {
        // Find matching frequency data
        const freq = frequencies.find(f => {
          const fName = f.symptom_name.toLowerCase();
          const cName = cluster.display_name.toLowerCase();
          return fName.includes(cName) || cName.includes(fName);
        });

        if (freq) {
          await updateClusterStats(pool, user_id, cluster.cluster_key, {
            count_7d: freq.count_7d,
            count_30d: freq.count_30d,
            trend: freq.trend,
            lastTriggered: freq.last_occurred,
          });
          clustersUpdated++;
        }
      }

      // Update cluster priority based on frequency
      await pool.query(
        `UPDATE problem_clusters SET
           priority = count_7d * 3 + count_30d,
           updated_at = NOW()
         WHERE user_id = $1 AND is_active = TRUE`,
        [user_id]
      );

      usersProcessed++;
    } catch (err) {
      console.error(`[R&D] Failed to update frequencies for user ${user_id}:`, err.message);
    }
  }

  return { usersProcessed, clustersUpdated };
}

// ─── Step 3: Optimize scripts ───────────────────────────────────────────────

/**
 * Regenerate scripts for clusters with significant trend changes.
 *
 * Rules:
 *   - Cluster trend = 'increasing' → add more detailed questions
 *   - Cluster trend = 'decreasing' → reduce questions (don't over-ask)
 *   - Cluster inactive for 30+ days → deactivate
 */
async function optimizeScripts(pool, activeUserIds = null) {
  let regenerated = 0;

  // If activeUserIds is explicitly empty → skip
  if (Array.isArray(activeUserIds) && activeUserIds.length === 0) {
    return { regenerated: 0 };
  }

  // Find clusters that need optimization (filtered by lifecycle)
  let query = `SELECT pc.*, ts.version, ts.id as script_id
     FROM problem_clusters pc
     LEFT JOIN triage_scripts ts ON ts.cluster_id = pc.id AND ts.is_active = TRUE AND ts.script_type = 'initial'
     WHERE pc.is_active = TRUE
       AND (
         pc.trend = 'increasing' AND pc.count_7d >= 3
         OR pc.trend = 'decreasing' AND pc.count_30d = 0
         OR ts.id IS NULL
       )`;
  const params = [];
  if (activeUserIds && activeUserIds.length > 0) {
    query += ` AND pc.user_id = ANY($1)`;
    params.push(activeUserIds);
  }
  const { rows: clusters } = await pool.query(query, params);

  for (const cluster of clusters) {
    try {
      // Deactivate clusters with no activity in 30 days
      if (cluster.trend === 'decreasing' && cluster.count_30d === 0) {
        await pool.query(
          `UPDATE problem_clusters SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
          [cluster.id]
        );
        continue;
      }

      // Regenerate script
      await generateScriptForCluster(pool, cluster.user_id, cluster);
      regenerated++;
    } catch (err) {
      console.error(`[R&D] Failed to optimize script for cluster ${cluster.id}:`, err.message);
    }
  }

  return { regenerated };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  runNightlyCycle,
  processFallbackLogs,
  updateAllClusterFrequencies,
  optimizeScripts,
  labelSymptom,
  processSemiActiveWithTimeout,
  MAX_CYCLE_MS,
};
