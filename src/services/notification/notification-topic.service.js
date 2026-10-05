'use strict';

const { t } = require('../../i18n');

const RECENT_SYMPTOM_DAYS = 7;
const DAY_MS = 86400000;

// These aliases identify persisted values, not copy shown to users. Display
// names come from the locale catalog so a Vietnamese profile also works in EN.
const CONDITION_ALIASES = {
  diabetes: [
    'tiểu đường',
    'tiểu đường type 1',
    'tiểu đường type 2',
    'đái tháo đường',
    'diabetes',
    'diabetes mellitus',
    'type 1 diabetes',
    'type 2 diabetes',
  ],
  prediabetes: ['tiền tiểu đường', 'tiền đái tháo đường', 'prediabetes', 'pre-diabetes'],
  hypertension: ['cao huyết áp', 'huyết áp cao', 'tăng huyết áp', 'hypertension'],
  heart_disease: ['bệnh tim', 'tim mạch', 'heart disease'],
  dyslipidemia: ['mỡ máu', 'mỡ máu cao', 'dyslipidemia', 'high cholesterol'],
  vertigo: ['tiền đình', 'rối loạn tiền đình', 'vertigo'],
  gastric_pain: ['đau dạ dày', 'gastric pain'],
  gout: ['gout', 'gút', 'bệnh gout', 'bệnh gút'],
};

const SYMPTOM_ALIASES = {
  headache: ['đau đầu', 'headache'],
  abdominal_pain: ['đau bụng', 'abdominal pain'],
  dizziness: ['chóng mặt', 'hoa mắt', 'dizziness'],
  fatigue: ['mệt mỏi', 'mệt', 'fatigue', 'tiredness'],
  chest_pain: ['đau ngực', 'chest pain'],
  dyspnea: ['khó thở', 'shortness of breath', 'dyspnea'],
  back_pain: ['đau lưng', 'back pain'],
  joint_pain: ['đau khớp', 'joint pain'],
  insomnia: ['mất ngủ', 'khó ngủ', 'insomnia'],
  fever: ['sốt', 'fever'],
  cough: ['ho', 'cough'],
  nausea: ['buồn nôn', 'nausea'],
  diarrhea: ['tiêu chảy', 'diarrhea'],
  constipation: ['táo bón', 'constipation'],
  rash: ['phát ban', 'rash'],
  shoulder_pain: ['đau vai', 'shoulder pain'],
  neck_pain: ['đau cổ', 'đau cổ vai gáy', 'neck pain'],
  chest_tightness: ['tức ngực', 'chest tightness'],
  hyperglycemia: ['đường huyết cao', 'hyperglycemia'],
  gastric_pain: ['đau dạ dày', 'gastric pain'],
  heartburn: ['ợ nóng', 'heartburn'],
  anxiety: ['lo lắng', 'anxiety'],
  stress: ['căng thẳng', 'stress'],
  thirst: ['khát nước', 'thirst'],
  numbness: ['tê tay chân', 'numbness'],
  palpitations: ['tim đập nhanh', 'palpitations'],
};

const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function aliasesIndex(aliases, prefix) {
  const index = new Map();
  for (const [code, values] of Object.entries(aliases)) {
    for (const value of [code, `${prefix}_${code}`, ...values]) index.set(normalize(value), code);
  }
  return index;
}

const conditionIndex = aliasesIndex(CONDITION_ALIASES, 'condition');
const symptomIndex = aliasesIndex(SYMPTOM_ALIASES, 'symptom');
const NO_CONDITION = new Set(['', 'khong co', 'khong', 'none', 'no', 'khac', 'other']);

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.trim() ? [value] : [];
  }
}

function localizeTopic(topic, language = 'vi') {
  if (!topic) return null;
  const lang = language === 'en' ? 'en' : 'vi';
  const kind = topic.kind === 'medical_condition' ? 'condition' : 'symptom';
  return {
    ...topic,
    display_name: t(`notification.topic.${kind}.${topic.code}`, lang),
  };
}

function topicMetadata(topic) {
  if (!topic) return null;
  return {
    kind: topic.kind,
    code: topic.code,
    recordedAt: topic.last_triggered_at || null,
  };
}

function buildNotificationTopics({
  clusters = [],
  frequencies = [],
  medicalConditions = [],
  language = 'vi',
  now = new Date(),
}) {
  const conditions = list(medicalConditions).filter((value) => !NO_CONDITION.has(normalize(value)));
  const conditionNames = new Set(conditions.map(normalize));
  const conditionCodes = new Set(
    conditions.map((value) => conditionIndex.get(normalize(value))).filter(Boolean)
  );
  const topCondition = conditions.length
    ? localizeTopic(
        {
          kind: 'medical_condition',
          code: conditionIndex.get(normalize(conditions[0])) || 'other',
          last_triggered_at: null,
        },
        language
      )
    : null;

  const recentSymptoms = [];
  for (const cluster of clusters) {
    const key = normalize(cluster.cluster_key);
    const name = normalize(cluster.display_name);
    const conditionCode = conditionIndex.get(key) || conditionIndex.get(name);
    // A disease seeded into a legacy symptom cluster remains a disease. It is
    // never evidence of a new symptom, even if the profile no longer lists it.
    const alsoSymptom = symptomIndex.get(key) || symptomIndex.get(name);
    if (
      conditionNames.has(name) ||
      conditionCodes.has(conditionCode) ||
      (conditionCode && !alsoSymptom)
    )
      continue;
    const code = symptomIndex.get(key) || symptomIndex.get(name) || 'other';
    const frequency = frequencies.find((entry) => {
      const frequencyName = normalize(entry.symptom_name);
      const frequencyCode = symptomIndex.get(frequencyName);
      return (
        frequencyName === name ||
        frequencyName === key ||
        (code !== 'other' && frequencyCode === code)
      );
    });
    const timestamps = [cluster.last_triggered_at, frequency?.last_triggered_at]
      .filter(Boolean)
      .map((value) => new Date(value))
      .filter((value) => Number.isFinite(value.getTime()));
    const recorded = timestamps.sort((a, b) => b.getTime() - a.getTime())[0];
    if (!recorded) continue;
    const age = now.getTime() - recorded.getTime();
    if (!Number.isFinite(age) || age < 0 || age > RECENT_SYMPTOM_DAYS * DAY_MS) continue;
    recentSymptoms.push(
      localizeTopic(
        {
          ...cluster,
          kind: 'symptom',
          code,
          last_triggered_at: recorded.toISOString(),
          count_7d: Math.max(0, Number(frequency?.count_7d ?? cluster.count_7d) || 0),
          trend: frequency?.trend || cluster.trend || 'stable',
        },
        language
      )
    );
  }

  return { topSymptom: recentSymptoms[0] || null, topCondition, recentSymptoms };
}

async function readNotificationTopics(pool, userId, language = 'vi', now = new Date()) {
  const [clusterRes, profileRes, frequencyRes] = await Promise.all([
    pool.query(
      `SELECT pc.cluster_key, pc.display_name, pc.trend, pc.count_7d, pc.priority, pc.source,
              pc.last_triggered_at
         FROM problem_clusters pc
        WHERE pc.user_id = $1 AND pc.is_active = TRUE
        ORDER BY pc.priority DESC, pc.count_7d DESC, pc.id ASC
        LIMIT 20`,
      [userId]
    ),
    pool.query('SELECT medical_conditions FROM user_onboarding_profiles WHERE user_id = $1', [
      userId,
    ]),
    pool.query(
      `SELECT symptom_name, count_7d, trend,
              last_occurred::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS last_triggered_at
         FROM symptom_frequency
        WHERE user_id = $1 AND last_occurred IS NOT NULL
        ORDER BY last_occurred DESC, symptom_name ASC`,
      [userId]
    ),
  ]);
  return buildNotificationTopics({
    clusters: clusterRes.rows,
    frequencies: frequencyRes.rows,
    medicalConditions: profileRes.rows[0]?.medical_conditions || [],
    language,
    now,
  });
}

function resolveSymptomLabel(codeOrName, language = 'vi') {
  return localizeTopic(
    { kind: 'symptom', code: symptomIndex.get(normalize(codeOrName)) || 'other' },
    language
  ).display_name;
}

function consecutiveTiredDays(checkins, now = new Date()) {
  const dateKey = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (kind) => parts.find((entry) => entry.type === kind)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const today = Date.parse(`${dateKey(now)}T00:00:00Z`);
  const entries = checkins.map((entry) => ({ ...entry, day: dateKey(entry.session_date) }));
  const seen = new Set();
  let expected = null;
  let count = 0;
  for (const entry of entries) {
    if (!entry.day || seen.has(entry.day)) continue;
    seen.add(entry.day);
    const day = Date.parse(`${entry.day}T00:00:00Z`);
    if (!Number.isFinite(day) || day > today) continue;
    if (expected === null) {
      if (today - day > DAY_MS) break;
      expected = day;
    }
    if (day !== expected || !['tired', 'very_tired'].includes(entry.initial_status)) break;
    count++;
    expected -= DAY_MS;
  }
  return count;
}

module.exports = {
  buildNotificationTopics,
  consecutiveTiredDays,
  localizeTopic,
  readNotificationTopics,
  resolveSymptomLabel,
  topicMetadata,
};
