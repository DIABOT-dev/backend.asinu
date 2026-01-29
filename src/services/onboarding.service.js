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
      medical_conditions,
      chronic_symptoms,
      joint_issues,
      flexibility,
      stairs_performance,
      exercise_freq,
      walking_habit,
      water_intake,
      sleep_duration,
      created_at,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,NOW(),NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      age = EXCLUDED.age,
      gender = EXCLUDED.gender,
      goal = EXCLUDED.goal,
      body_type = EXCLUDED.body_type,
      medical_conditions = EXCLUDED.medical_conditions,
      chronic_symptoms = EXCLUDED.chronic_symptoms,
      joint_issues = EXCLUDED.joint_issues,
      flexibility = EXCLUDED.flexibility,
      stairs_performance = EXCLUDED.stairs_performance,
      exercise_freq = EXCLUDED.exercise_freq,
      walking_habit = EXCLUDED.walking_habit,
      water_intake = EXCLUDED.water_intake,
      sleep_duration = EXCLUDED.sleep_duration,
      updated_at = NOW()
    RETURNING user_id, age, gender, goal, body_type, medical_conditions, chronic_symptoms,
              joint_issues, flexibility, stairs_performance, exercise_freq, walking_habit,
              water_intake, sleep_duration, created_at, updated_at`,
    [
      userId,
      age,
      gender,
      goal,
      body_type,
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
  getProfile,
};
