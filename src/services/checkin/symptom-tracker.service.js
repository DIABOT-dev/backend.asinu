/**
 * Symptom Tracker Service
 *
 * Extract triệu chứng từ triage_messages và lưu vào symptom_logs + symptom_frequency.
 * Gọi sau mỗi lần triage hoàn thành.
 */

// Triệu chứng thường gặp — dùng để match từ câu trả lời
const KNOWN_SYMPTOMS = [
  'mệt mỏi', 'chóng mặt', 'đau đầu', 'buồn nôn', 'khát nước',
  'ăn không ngon', 'đau bụng', 'khó thở', 'đau ngực', 'tức ngực',
  'hoa mắt', 'vã mồ hôi', 'mất ngủ', 'sốt', 'ho', 'đau lưng',
  'đau khớp', 'tiêu chảy', 'táo bón', 'phát ban', 'ngứa',
  'lo lắng', 'căng thẳng', 'run tay', 'tim đập nhanh', 'ngất',
  // English
  'fatigue', 'dizziness', 'headache', 'nausea', 'thirst',
  'chest pain', 'shortness of breath', 'blurred vision',
];

// Câu trả lời KHÔNG phải triệu chứng
const NON_SYMPTOM_ANSWERS = new Set([
  'nhẹ', 'trung bình', 'khá nặng', 'rất nặng',
  'vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài ngày nay',
  'đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn',
  'đã đỡ nhiều', 'mệt hơn trước', 'đã đỡ hơn',
  'ngủ ít', 'bỏ bữa', 'căng thẳng', 'quên uống thuốc', 'không rõ',
  'nghỉ ngơi', 'ăn uống', 'uống nước', 'uống thuốc', 'chưa làm gì',
  'lần đầu', 'thỉnh thoảng', 'hay bị', 'gần đây bị nhiều hơn',
  'đã uống', 'quên', 'chưa đến giờ',
  'không có', 'không có gì thêm', 'không',
  'mild', 'moderate', 'severe', 'better', 'same', 'worse',
  'rested', 'nothing yet', 'not sure',
]);

/**
 * Extract triệu chứng từ triage_messages array.
 * Chỉ lấy từ câu hỏi TYPE 3 (triệu chứng) và TYPE 6 (red flag).
 */
function extractSymptoms(triageMessages) {
  const symptoms = [];
  if (!Array.isArray(triageMessages)) return symptoms;

  for (const msg of triageMessages) {
    const q = (msg.question || '').toLowerCase();
    const ans = (msg.answer || '').toLowerCase();

    // Chỉ extract từ câu hỏi về triệu chứng
    const isSymptomQ = q.includes('triệu chứng') || q.includes('symptoms')
      || q.includes('dấu hiệu') || q.includes('vấn đề gì')
      || q.includes('tình trạng nào');

    if (!isSymptomQ) continue;

    // Split câu trả lời (có thể multi-select: "mệt mỏi, chóng mặt, đau đầu")
    const parts = ans.split(/,|;/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (NON_SYMPTOM_ANSWERS.has(part)) continue;
      if (part.length < 2) continue;
      symptoms.push(part);
    }
  }

  return [...new Set(symptoms)]; // dedupe
}

/**
 * Extract severity từ triage_messages.
 */
function extractSeverity(triageMessages) {
  if (!Array.isArray(triageMessages)) return null;
  for (const msg of triageMessages) {
    const q = (msg.question || '').toLowerCase();
    const ans = (msg.answer || '').toLowerCase();
    if (q.includes('mức độ') || q.includes('how severe') || q.includes('nặng thế nào')) {
      return ans;
    }
  }
  return null;
}

/**
 * Lưu triệu chứng vào symptom_logs sau khi triage hoàn thành.
 */
async function saveSymptomLogs(pool, userId, checkinId, triageMessages, sessionDate) {
  const symptoms = extractSymptoms(triageMessages);
  if (symptoms.length === 0) return;

  const severity = extractSeverity(triageMessages);
  const date = sessionDate || new Date().toISOString().slice(0, 10);

  for (const symptom of symptoms) {
    await pool.query(
      `INSERT INTO symptom_logs (user_id, checkin_id, symptom_name, severity, occurred_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [userId, checkinId, symptom, severity, date]
    ).catch(err => console.error('[SymptomTracker] Failed to save symptom log:', err.message));
  }

  // Cập nhật frequency
  await updateSymptomFrequency(pool, userId).catch(() => {});
}

/**
 * Cập nhật bảng symptom_frequency cho user.
 * Tính count_7d, count_30d, trend.
 */
async function updateSymptomFrequency(pool, userId) {
  // Lấy tất cả symptom_logs 30 ngày gần nhất
  const { rows } = await pool.query(
    `SELECT symptom_name, occurred_date
     FROM symptom_logs
     WHERE user_id = $1 AND occurred_date >= CURRENT_DATE - INTERVAL '30 days'
     ORDER BY occurred_date DESC`,
    [userId]
  );

  if (rows.length === 0) return;

  // Group by symptom
  const bySymptom = {};
  for (const r of rows) {
    if (!bySymptom[r.symptom_name]) bySymptom[r.symptom_name] = [];
    bySymptom[r.symptom_name].push(r.occurred_date);
  }

  const now = new Date();
  const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
  const d14 = new Date(now); d14.setDate(d14.getDate() - 14);

  for (const [symptom, dates] of Object.entries(bySymptom)) {
    const count7d = dates.filter(d => new Date(d) >= d7).length;
    const count30d = dates.length;
    const lastOccurred = dates[0]; // already sorted DESC

    // Trend: so sánh 7 ngày gần vs 7 ngày trước đó
    const countPrev7d = dates.filter(d => {
      const dd = new Date(d);
      return dd >= d14 && dd < d7;
    }).length;

    let trend = 'stable';
    if (count7d > countPrev7d + 1) trend = 'increasing';
    else if (count7d < countPrev7d - 1) trend = 'decreasing';

    await pool.query(
      `INSERT INTO symptom_frequency (user_id, symptom_name, count_7d, count_30d, trend, last_occurred, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, symptom_name) DO UPDATE SET
         count_7d = $3, count_30d = $4, trend = $5, last_occurred = $6, updated_at = NOW()`,
      [userId, symptom, count7d, count30d, trend, lastOccurred]
    ).catch(err => console.error('[SymptomTracker] Failed to update frequency:', err.message));
  }
}

/**
 * Lấy symptom frequency cho AI context.
 * Trả về string mô tả tần suất triệu chứng.
 */
async function getSymptomFrequencyContext(pool, userId) {
  const { rows } = await pool.query(
    `SELECT symptom_name, count_7d, count_30d, trend, last_occurred
     FROM symptom_frequency
     WHERE user_id = $1 AND count_30d > 0
     ORDER BY count_7d DESC, count_30d DESC
     LIMIT 10`,
    [userId]
  );

  if (rows.length === 0) return null;

  return rows.map(r => {
    const trendLabel = r.trend === 'increasing' ? '↑ tăng' : r.trend === 'decreasing' ? '↓ giảm' : '→ ổn định';
    return `- ${r.symptom_name}: ${r.count_7d} lần/7 ngày, ${r.count_30d} lần/30 ngày (${trendLabel})`;
  }).join('\n');
}

/**
 * Lấy lịch sử uống thuốc 7 ngày gần nhất.
 */
async function getMedicationAdherenceContext(pool, userId) {
  const { rows } = await pool.query(
    `SELECT medication_date, status
     FROM medication_adherence
     WHERE user_id = $1 AND medication_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY medication_date DESC`,
    [userId]
  );

  if (rows.length === 0) return null;

  const taken = rows.filter(r => r.status === 'taken').length;
  const skipped = rows.filter(r => r.status === 'skipped').length;
  const total = rows.length;

  let summary = `Thuốc 7 ngày: ${taken}/${total} ngày uống đúng`;
  if (skipped > 0) summary += ` (bỏ ${skipped} ngày ⚠️)`;

  return summary;
}

module.exports = {
  extractSymptoms,
  saveSymptomLogs,
  updateSymptomFrequency,
  getSymptomFrequencyContext,
  getMedicationAdherenceContext,
};
