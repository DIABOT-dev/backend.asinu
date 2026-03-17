/**
 * Onboarding Service
 * Business logic cho user onboarding
 * - Normalize user input
 * - Validate and format data
 */

// =====================================================
// HELPERS
// =====================================================

/**
 * Normalize text value
 * @param {*} value - Input value
 * @returns {string} - Trimmed string
 */
const normalizeText = (value) => String(value || '').trim();

/**
 * Extract label from issue item
 * @param {*} item - Issue item (string or object)
 * @returns {string} - Label string
 */
const issueLabel = (item) => {
  if (typeof item === 'string') return normalizeText(item);
  if (!item || typeof item !== 'object') return '';
  return normalizeText(item.other_text || item.label || item.key || '');
};

/**
 * Normalize string list with deduplication
 * @param {Array} items - Array of items
 * @returns {Array<string>} - Deduplicated string array
 */
const normalizeStringList = (items) => {
  if (!Array.isArray(items)) return [];
  
  const result = [];
  const seen = new Set();
  
  for (const item of items) {
    const label = issueLabel(item);
    if (!label) continue;
    
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    
    seen.add(key);
    result.push(label);
  }
  
  return result;
};

/**
 * Normalize joint issues with full object structure
 * @param {Array} items - Array of joint issue objects
 * @returns {Array<Object>} - Normalized joint issues
 */
const normalizeJointIssues = (items) => {
  if (!Array.isArray(items)) return [];
  
  const result = [];
  const seen = new Set();
  
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    
    const key = normalizeText(item.key);
    const label = normalizeText(item.label);
    const otherText = item.other_text ? normalizeText(item.other_text) : null;
    
    if (!key || !label) continue;
    
    const dedupeKey = `${key.toLowerCase()}|${label.toLowerCase()}|${(otherText || '').toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    
    seen.add(dedupeKey);
    result.push(otherText ? { key, label, other_text: otherText } : { key, label });
  }
  
  return result;
};

// =====================================================
// DATABASE OPERATIONS
// =====================================================

/**
 * Upsert user onboarding profile
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} profile - Profile data
 * @returns {Promise<Object>} - Saved profile
 */
async function upsertProfile(pool, userId, profile) {
  const {
    age,
    gender,
    goal,
    body_type,
    checkup_freq,
    medical_conditions,
    chronic_symptoms,
    joint_issues,
    flexibility,
    stairs_performance,
    exercise_freq,
    walking_habit,
    water_intake,
    sleep_duration,
  } = profile;

  const normalizedMedical = normalizeStringList(medical_conditions);
  const normalizedSymptoms = normalizeStringList(chronic_symptoms);
  const normalizedJoints = normalizeJointIssues(joint_issues);

  const result = await pool.query(
    `INSERT INTO user_onboarding_profiles (
      user_id,
      age,
      gender,
      goal,
      body_type,
      checkup_freq,
      medical_conditions,
      chronic_symptoms,
      joint_issues,
      flexibility,
      stairs_performance,
      exercise_freq,
      walking_habit,
      water_intake,
      sleep_duration,
      onboarding_completed_at,
      created_at,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,NOW(),NOW(),NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      age = EXCLUDED.age,
      gender = EXCLUDED.gender,
      goal = EXCLUDED.goal,
      body_type = EXCLUDED.body_type,
      checkup_freq = EXCLUDED.checkup_freq,
      medical_conditions = EXCLUDED.medical_conditions,
      chronic_symptoms = EXCLUDED.chronic_symptoms,
      joint_issues = EXCLUDED.joint_issues,
      flexibility = EXCLUDED.flexibility,
      stairs_performance = EXCLUDED.stairs_performance,
      exercise_freq = EXCLUDED.exercise_freq,
      walking_habit = EXCLUDED.walking_habit,
      water_intake = EXCLUDED.water_intake,
      sleep_duration = EXCLUDED.sleep_duration,
      onboarding_completed_at = COALESCE(user_onboarding_profiles.onboarding_completed_at, NOW()),
      updated_at = NOW()
    RETURNING user_id, age, gender, goal, body_type, checkup_freq, medical_conditions,
              chronic_symptoms, joint_issues, flexibility, stairs_performance, exercise_freq,
              walking_habit, water_intake, sleep_duration, onboarding_completed_at, created_at, updated_at`,
    [
      userId,
      age,
      gender,
      goal,
      body_type,
      checkup_freq,
      JSON.stringify(normalizedMedical),
      JSON.stringify(normalizedSymptoms),
      JSON.stringify(normalizedJoints),
      flexibility,
      stairs_performance,
      exercise_freq,
      walking_habit,
      water_intake,
      sleep_duration,
    ]
  );

  return result.rows[0];
}

/**
 * Get user onboarding profile
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} - Profile or null
 */
async function getProfile(pool, userId) {
  const result = await pool.query(
    'SELECT * FROM user_onboarding_profiles WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Lưu profile do AI thu thập (linh hoạt hơn, không ràng buộc enum).
 * @param {Object} pool
 * @param {number} userId
 * @param {Object} aiProfile - Profile object từ AI
 */
async function upsertProfileFromAI(pool, userId, aiProfile) {
  const medical  = Array.isArray(aiProfile.medical_conditions)  ? aiProfile.medical_conditions  : [];
  const symptoms = Array.isArray(aiProfile.chronic_symptoms)    ? aiProfile.chronic_symptoms    : [];
  const joints   = Array.isArray(aiProfile.joint_issues)        ? aiProfile.joint_issues        : [];

  const result = await pool.query(
    `INSERT INTO user_onboarding_profiles (
      user_id, age, gender, goal, body_type,
      medical_conditions, chronic_symptoms, joint_issues,
      exercise_freq, sleep_duration, water_intake, checkup_freq,
      flexibility, stairs_performance, walking_habit,
      raw_profile, onboarding_completed_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6::jsonb, $7::jsonb, $8::jsonb,
      $9, $10, $11, $12, $13, $14, $15,
      $16::jsonb, NOW(), NOW(), NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      age                     = EXCLUDED.age,
      gender                  = EXCLUDED.gender,
      goal                    = EXCLUDED.goal,
      body_type               = EXCLUDED.body_type,
      medical_conditions      = EXCLUDED.medical_conditions,
      chronic_symptoms        = EXCLUDED.chronic_symptoms,
      joint_issues            = EXCLUDED.joint_issues,
      exercise_freq           = EXCLUDED.exercise_freq,
      sleep_duration          = EXCLUDED.sleep_duration,
      water_intake            = EXCLUDED.water_intake,
      checkup_freq            = EXCLUDED.checkup_freq,
      flexibility             = EXCLUDED.flexibility,
      stairs_performance      = EXCLUDED.stairs_performance,
      walking_habit           = EXCLUDED.walking_habit,
      raw_profile             = EXCLUDED.raw_profile,
      onboarding_completed_at = COALESCE(user_onboarding_profiles.onboarding_completed_at, NOW()),
      updated_at              = NOW()
    RETURNING *`,
    [
      userId,
      aiProfile.age         || null,
      aiProfile.gender      || null,
      aiProfile.goal        || null,
      aiProfile.body_type   || null,
      JSON.stringify(medical),
      JSON.stringify(symptoms),
      JSON.stringify(joints),
      aiProfile.exercise_freq       || null,
      aiProfile.sleep_duration      || null,
      aiProfile.water_intake        || null,
      aiProfile.checkup_freq        || null,
      aiProfile.flexibility         || null,
      aiProfile.stairs_performance  || null,
      aiProfile.walking_habit       || null,
      JSON.stringify(aiProfile),
    ]
  );

  return result.rows[0];
}

// =====================================================
// ONBOARDING V2 — RISK SCORING
// =====================================================

/**
 * Calculate risk score from onboarding V2 data.
 * @param {Object} data - V2 onboarding data
 * @returns {number} - Risk score
 */
function calcRiskScore(data) {
  let score = 0;

  const year = parseInt(data.birth_year);
  if (!isNaN(year)) {
    const age = new Date().getFullYear() - year;
    if (age >= 70) score += 40;
    else if (age >= 60) score += 30;
    else if (age >= 50) score += 20;
    else if (age >= 40) score += 10;
  }

  const diseases = Array.isArray(data.medical_conditions) ? data.medical_conditions : [];
  const DISEASE_SCORES = {
    'Tiểu đường': 25,
    'Bệnh tim': 25,
    'Cao huyết áp': 20,
    'Tiền tiểu đường': 15,
    'Mỡ máu': 15,
    'Tiền đình': 10,
    'Đau dạ dày': 10,
    'Gout': 10,
  };
  diseases.forEach(d => { score += DISEASE_SCORES[d] || 10; });

  const h = parseFloat(data.height_cm);
  const w = parseFloat(data.weight_kg);
  if (h > 0 && w > 0) {
    const bmi = w / ((h / 100) ** 2);
    if (bmi >= 30) score += 20;
    else if (bmi >= 25) score += 10;
  }

  if (data.daily_medication === 'Có') score += 10;
  if (data.exercise_freq === 'Ít vận động') score += 10;
  if (data.sleep_hours === 'Ít hơn 5 giờ') score += 15;
  else if (data.sleep_hours === '6-7 giờ') score += 5;
  if (data.sweet_intake === 'Thường xuyên') score += 10;
  if (data.post_meal_drowsy === 'Thường xuyên') score += 10;
  if (data.dinner_time === 'Sau 20 giờ') score += 5;

  return score;
}

/**
 * Determine user group from risk score.
 * @param {number} score
 * @returns {string}
 */
function calcGroup(score) {
  if (score <= 30) return 'wellness';
  if (score <= 70) return 'metabolic_risk';
  return 'monitoring';
}

/**
 * Upsert user onboarding profile (V2 — fixed 5-page wizard).
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} data - V2 onboarding data
 * @returns {Promise<Object>} - Saved profile
 */
async function upsertProfileV2(pool, userId, data) {
  const {
    birth_year,
    gender,
    height_cm,
    weight_kg,
    phone,
    blood_type,
    medical_conditions,
    daily_medication,
    checkup_freq,
    exercise_freq,
    sleep_hours,
    meals_per_day,
    post_meal_drowsy,
    dinner_time,
    sweet_intake,
    user_goal,
  } = data;

  const normalizedConditions = Array.isArray(medical_conditions) ? medical_conditions : [];
  const normalizedGoals = Array.isArray(user_goal) ? user_goal : [];

  const risk_score = calcRiskScore(data);
  const user_group = calcGroup(risk_score);

  const result = await pool.query(
    `INSERT INTO user_onboarding_profiles (
      user_id,
      birth_year,
      gender,
      height_cm,
      weight_kg,
      blood_type,
      medical_conditions,
      chronic_symptoms,
      daily_medication,
      checkup_freq,
      exercise_freq,
      sleep_hours,
      meals_per_day,
      post_meal_drowsy,
      dinner_time,
      sweet_intake,
      user_goal,
      risk_score,
      user_group,
      onboarding_completed_at,
      created_at,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, '[]'::jsonb,
      $8, $9, $10, $11, $12, $13, $14, $15,
      $16::jsonb, $17, $18,
      NOW(), NOW(), NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      birth_year              = EXCLUDED.birth_year,
      gender                  = EXCLUDED.gender,
      height_cm               = EXCLUDED.height_cm,
      weight_kg               = EXCLUDED.weight_kg,
      blood_type              = EXCLUDED.blood_type,
      medical_conditions      = EXCLUDED.medical_conditions,
      chronic_symptoms        = '[]'::jsonb,
      daily_medication        = EXCLUDED.daily_medication,
      checkup_freq            = EXCLUDED.checkup_freq,
      exercise_freq           = EXCLUDED.exercise_freq,
      sleep_hours             = EXCLUDED.sleep_hours,
      meals_per_day           = EXCLUDED.meals_per_day,
      post_meal_drowsy        = EXCLUDED.post_meal_drowsy,
      dinner_time             = EXCLUDED.dinner_time,
      sweet_intake            = EXCLUDED.sweet_intake,
      user_goal               = EXCLUDED.user_goal,
      risk_score              = EXCLUDED.risk_score,
      user_group              = EXCLUDED.user_group,
      onboarding_completed_at = NOW(),
      updated_at              = NOW()
    RETURNING *`,
    [
      userId,
      birth_year ? parseInt(birth_year) : null,
      gender || null,
      height_cm ? parseFloat(height_cm) : null,
      weight_kg ? parseFloat(weight_kg) : null,
      blood_type || null,
      JSON.stringify(normalizedConditions),
      daily_medication || null,
      checkup_freq || null,
      exercise_freq || null,
      sleep_hours || null,
      meals_per_day || null,
      post_meal_drowsy || null,
      dinner_time || null,
      sweet_intake || null,
      JSON.stringify(normalizedGoals),
      risk_score,
      user_group,
    ]
  );

  const saved = result.rows[0];

  // Update phone number in users table if provided
  if (phone && /^0\d{9}$/.test(phone.trim())) {
    await pool.query(
      'UPDATE users SET phone_number = $1 WHERE id = $2 AND (phone_number IS NULL OR phone_number = \'\')',
      [phone.trim(), userId]
    );
  }

  return saved;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  // Helpers
  normalizeText,
  issueLabel,
  normalizeStringList,
  normalizeJointIssues,

  // Database operations
  upsertProfile,
  upsertProfileFromAI,
  upsertProfileV2,
  getProfile,
};
