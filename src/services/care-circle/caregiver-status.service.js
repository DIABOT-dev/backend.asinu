/**
 * Helpers for surfacing a user's caregiver-connection state in check-in
 * responses. Required by MVP audit (FIX #4): frontend needs to know
 * whether to show the "add a caregiver" CTA, especially when the
 * check-in result is high/emergency.
 */

const logger = require('../../lib/logger');

/**
 * Returns true if the user has at least one accepted Care Circle connection
 * where the caregiver is configured to receive alerts.
 */
async function userHasActiveCaregiver(pool, userId) {
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM user_connections
        WHERE requester_id = $1
          AND status = 'accepted'
          AND COALESCE((permissions->>'can_receive_alerts')::boolean, false) = true
        LIMIT 1`,
      [userId]
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn('caregiver_status.lookup_failed', { user_id: userId, err });
    // Fail-open: if the lookup fails, return true so we don't spam the user
    // with "no caregiver" warnings during a DB hiccup.
    return true;
  }
}

/**
 * Build the caregiver_status fields to merge into a check-in response.
 * Pass the resolved risk_tier so we only fire the CTA when it matters.
 */
async function buildCaregiverStatus(pool, userId, { riskTier } = {}) {
  const hasCaregiver = await userHasActiveCaregiver(pool, userId);
  const tier = String(riskTier || '').toLowerCase();
  const isUrgent = tier === 'high' || tier === 'emergency';

  return {
    caregiver_status: hasCaregiver ? 'connected' : 'no_caregiver_connected',
    needs_caregiver_cta: !hasCaregiver,
    show_urgent_caregiver_warning: !hasCaregiver && isUrgent,
  };
}

module.exports = { userHasActiveCaregiver, buildCaregiverStatus };
