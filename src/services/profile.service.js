/**
 * Profile Service
 * Business logic cho user profile operations
 */

const { t } = require('../i18n');

/**
 * Get user profile with onboarding data
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, profile, error }
 */
async function getProfile(pool, userId) {
  try {
    const userResult = await pool.query(
      `SELECT id, email, phone, phone_number, display_name, full_name, avatar_url, created_at
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return { ok: false, error: t('error.user_not_found'), statusCode: 404 };
    }

    const user = userResult.rows[0];

    // Get onboarding profile for health info
    const onboardingResult = await pool.query(
      `SELECT display_name, age, gender, goal, body_type, 
              date_of_birth, height_cm, weight_kg, blood_type,
              medical_conditions, chronic_symptoms
       FROM user_onboarding_profiles
       WHERE user_id = $1`,
      [userId]
    );

    const onboarding = onboardingResult.rows[0] || null;

    // Get care circle connections (guardians/carers)
    const careCircleResult = await pool.query(
      `SELECT 
        cc.id,
        cc.status,
        u.id as guardian_id,
        u.full_name as guardian_name,
        u.phone as guardian_phone,
        u.email as guardian_email
       FROM care_circle cc
       JOIN users u ON cc.guardian_id = u.id
       WHERE cc.patient_id = $1 AND cc.status = 'active'
       ORDER BY cc.created_at DESC`,
      [userId]
    );

    const careCircle = careCircleResult.rows.map(row => ({
      id: String(row.id),
      guardianId: String(row.guardian_id),
      name: row.guardian_name || t('profile.guardian_label'),
      phone: row.guardian_phone,
      email: row.guardian_email,
      status: row.status
    }));

    // Calculate age from date_of_birth
    let age = null;
    if (onboarding?.date_of_birth) {
      const today = new Date();
      const birthDate = new Date(onboarding.date_of_birth);
      age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
    }

    // Combine medical_conditions and chronic_symptoms for chronic diseases
    const chronicDiseases = [
      ...(onboarding?.medical_conditions || []),
      ...(onboarding?.chronic_symptoms || [])
    ];

    const profile = {
      id: String(user.id),
      name: user.full_name || user.display_name || onboarding?.display_name || (user.email ? user.email.split('@')[0] : `User123 ${user.id}`),
      email: user.email || null,
      phone: user.phone || user.phone_number || null,
      relationship: t('profile.caregiver_label'),
      avatarUrl: user.avatar_url || null,
      // Health profile fields from onboarding
      dateOfBirth: onboarding?.date_of_birth || null,
      age: age,
      heightCm: onboarding?.height_cm || null,
      weightKg: onboarding?.weight_kg || null,
      bloodType: onboarding?.blood_type || null,
      chronicDiseases: chronicDiseases,
      // Care circle
      careCircle: careCircle,
      ...(onboarding && {
        ageRange: onboarding.age,
        gender: onboarding.gender,
        goal: onboarding.goal,
        bodyType: onboarding.body_type
      })
    };

    return { ok: true, profile };
  } catch (err) {
    console.error('[profile.service] getProfile failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Update user profile
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {Object} updates - { name, phone }
 * @returns {Promise<Object>} - { ok, profile, error }
 */
async function updateProfile(pool, userId, updates) {
  const { name, phone, dateOfBirth, gender, heightCm, weightKg, bloodType, chronicDiseases } = updates;

  try {
    // Update name and phone in users table
    const userFields = [];
    const userValues = [];
    let userParamIndex = 1;

    if (name !== undefined) {
      userFields.push(`full_name = $${userParamIndex}`);
      userValues.push(name);
      userParamIndex++;
    }

    if (phone !== undefined) {
      userFields.push(`phone = $${userParamIndex}`);
      userValues.push(phone);
      userParamIndex++;
    }

    if (userFields.length > 0) {
      userValues.push(userId);
      await pool.query(
        `UPDATE users SET ${userFields.join(', ')} WHERE id = $${userParamIndex}`,
        userValues
      );
    }

    // Check if onboarding profile exists, create if not
    const onboardingExists = await pool.query(
      'SELECT user_id FROM user_onboarding_profiles WHERE user_id = $1',
      [userId]
    );

    if (onboardingExists.rows.length === 0) {
      // Create new onboarding profile
      await pool.query(
        `INSERT INTO user_onboarding_profiles (user_id, display_name) VALUES ($1, $2)`,
        [userId, name || null]
      );
    }

    // Update health fields in onboarding profile
    const onboardingFields = [];
    const onboardingValues = [];
    let onboardingParamIndex = 1;

    if (name !== undefined) {
      onboardingFields.push(`display_name = $${onboardingParamIndex}`);
      onboardingValues.push(name);
      onboardingParamIndex++;
    }

    if (dateOfBirth !== undefined) {
      onboardingFields.push(`date_of_birth = $${onboardingParamIndex}`);
      onboardingValues.push(dateOfBirth);
      onboardingParamIndex++;
    }

    if (gender !== undefined) {
      onboardingFields.push(`gender = $${onboardingParamIndex}`);
      onboardingValues.push(gender);
      onboardingParamIndex++;
    }

    if (heightCm !== undefined) {
      onboardingFields.push(`height_cm = $${onboardingParamIndex}`);
      onboardingValues.push(heightCm);
      onboardingParamIndex++;
    }

    if (weightKg !== undefined) {
      onboardingFields.push(`weight_kg = $${onboardingParamIndex}`);
      onboardingValues.push(weightKg);
      onboardingParamIndex++;
    }

    if (bloodType !== undefined) {
      onboardingFields.push(`blood_type = $${onboardingParamIndex}`);
      onboardingValues.push(bloodType);
      onboardingParamIndex++;
    }

    if (chronicDiseases !== undefined) {
      onboardingFields.push(`medical_conditions = $${onboardingParamIndex}`);
      onboardingValues.push(JSON.stringify(chronicDiseases));
      onboardingParamIndex++;
    }

    if (onboardingFields.length > 0) {
      onboardingValues.push(userId);
      await pool.query(
        `UPDATE user_onboarding_profiles SET ${onboardingFields.join(', ')}, updated_at = NOW() WHERE user_id = $${onboardingParamIndex}`,
        onboardingValues
      );
    }

    // Fetch updated profile to return
    return await getProfile(pool, userId);
  } catch (err) {
    console.error('[profile.service] updateProfile failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

/**
 * Delete user account (hard delete - xóa toàn bộ dữ liệu)
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - { ok, message, error }
 */
async function deleteAccount(pool, userId) {
  const client = await pool.connect();
  
  try {
    // Bắt đầu transaction
    await client.query('BEGIN');

    console.log(`[profile.service] Deleting account for user ${userId}`);

    // Xóa các bảng liên quan theo thứ tự (child tables trước)
    // 1. Health & Wellness logs
    await client.query('DELETE FROM glucose_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM blood_pressure_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM weight_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM water_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM meal_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM insulin_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM medication_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM care_pulse_logs WHERE log_id IN (SELECT id FROM logs_common WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM logs_common WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM health_logs WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM logs WHERE user_id = $1', [userId]);

    // 2. Chat & AI
    await client.query('DELETE FROM chat_logs WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM chat_histories WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM asinu_brain_outcomes WHERE session_id IN (SELECT id FROM asinu_brain_sessions WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM asinu_brain_events WHERE session_id IN (SELECT id FROM asinu_brain_sessions WHERE user_id = $1)', [userId]);
    await client.query('DELETE FROM asinu_brain_sessions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM asinu_brain_context_snapshots WHERE user_id = $1', [userId]);

    // 3. Missions
    await client.query('DELETE FROM mission_history WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_missions WHERE user_id = $1', [userId]);

    // 4. Care Pulse & Monitoring
    await client.query('DELETE FROM care_pulse_events WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM care_pulse_engine_state WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM care_pulse_escalations WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM caregiver_alerts WHERE user_id = $1 OR caregiver_user_id = $1', [userId]);
    await client.query('DELETE FROM wellness_monitoring_config WHERE user_id = $1', [userId]);

    // 5. Wellness & Health Tracking
    await client.query('DELETE FROM user_activity_logs WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_health_scores WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_wellness_state WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM daily_wellness_summary WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM prompt_history WHERE user_id = $1', [userId]);

    // 6. Risk Engine & Alerts
    await client.query('DELETE FROM alert_decision_audit WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM asinu_trackers WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM risk_persistence WHERE user_id = $1', [userId]);

    // 7. Care Circle & Connections
    await client.query('DELETE FROM care_circle WHERE user_id = $1 OR member_user_id = $1', [userId]);
    await client.query('DELETE FROM user_connections WHERE user_id = $1 OR connected_user_id = $1', [userId]);
    await client.query('DELETE FROM user_baselines WHERE user_id = $1', [userId]);

    // 8. Notifications
    await client.query('DELETE FROM notifications WHERE user_id = $1', [userId]);

    // 9. Auth & Profile
    await client.query('DELETE FROM auth WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_onboarding_profiles WHERE user_id = $1', [userId]);

    // 10. Cuối cùng xóa user
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    // Commit transaction
    await client.query('COMMIT');

    console.log(`[profile.service] Successfully deleted account for user ${userId}`);
    return { ok: true, message: t('success.account_deleted') };
  } catch (err) {
    // Rollback nếu có lỗi
    await client.query('ROLLBACK');
    console.error('[profile.service] deleteAccount failed:', err);
    return { ok: false, error: t('profile.delete_account_error') };
  } finally {
    client.release();
  }
}

/**
 * Update push notification token
 * @param {Object} pool - Database pool
 * @param {number} userId - User ID
 * @param {string} pushToken - Push token
 * @returns {Promise<Object>} - { ok, error }
 */
async function updatePushToken(pool, userId, pushToken) {
  try {
    await pool.query(
      `UPDATE users SET push_token = $1, updated_at = NOW() WHERE id = $2`,
      [pushToken, userId]
    );

    return { ok: true };
  } catch (err) {
    console.error('[profile.service] updatePushToken failed:', err);
    return { ok: false, error: t('error.server') };
  }
}

module.exports = {
  getProfile,
  updateProfile,
  deleteAccount,
  updatePushToken
};
