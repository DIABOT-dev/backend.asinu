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
      fallbacksProcessed: 0,
      clustersCreated: 0,
      clustersUpdated: 0,
      scriptsRegenerated: 0,
      aiCallsMade: 0,
    };

    // Step 1: Process fallback logs (unknown symptoms → label → cluster)
    const fallbackStats = await processFallbackLogs(pool);
    stats.fallbacksProcessed = fallbackStats.processed;
    stats.clustersCreated = fallbackStats.clustersCreated;
    stats.aiCallsMade += fallbackStats.aiCalls;

    // Step 2: Update cluster frequencies for all active users
    const clusterStats = await updateAllClusterFrequencies(pool);
    stats.usersProcessed = clusterStats.usersProcessed;
    stats.clustersUpdated = clusterStats.clustersUpdated;

    // Step 3: Optimize scripts for clusters with trend changes
    const scriptStats = await optimizeScripts(pool);
    stats.scriptsRegenerated = scriptStats.regenerated;

    // Update cycle log
    await pool.query(
      `UPDATE rnd_cycle_logs SET
         completed_at = NOW(),
         status = 'completed',
         users_processed = $2,
         fallbacks_processed = $3,
         clusters_created = $4,
         clusters_updated = $5,
         scripts_regenerated = $6,
         ai_calls_made = $7
       WHERE id = $1`,
      [cycleLogId, stats.usersProcessed, stats.fallbacksProcessed,
       stats.clustersCreated, stats.clustersUpdated,
       stats.scriptsRegenerated, stats.aiCallsMade]
    );

    const elapsed = Date.now() - cycleStart.getTime();
    console.log(`[R&D Cycle] Completed in ${elapsed}ms:`, stats);
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

// ─── Step 1: Process fallback logs ──────────────────────────────────────────

/**
 * Process pending fallback logs:
 *   - Group by user
 *   - AI labels each unknown symptom
 *   - Create new cluster or merge into existing
 *   - Generate script for new cluster
 */
async function processFallbackLogs(pool) {
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
async function updateAllClusterFrequencies(pool) {
  let usersProcessed = 0;
  let clustersUpdated = 0;

  // Get all users with active clusters
  const { rows: users } = await pool.query(
    `SELECT DISTINCT user_id FROM problem_clusters WHERE is_active = TRUE`
  );

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
async function optimizeScripts(pool) {
  let regenerated = 0;

  // Find clusters that need optimization
  const { rows: clusters } = await pool.query(
    `SELECT pc.*, ts.version, ts.id as script_id
     FROM problem_clusters pc
     LEFT JOIN triage_scripts ts ON ts.cluster_id = pc.id AND ts.is_active = TRUE AND ts.script_type = 'initial'
     WHERE pc.is_active = TRUE
       AND (
         pc.trend = 'increasing' AND pc.count_7d >= 3
         OR pc.trend = 'decreasing' AND pc.count_30d = 0
         OR ts.id IS NULL
       )`
  );

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
};
