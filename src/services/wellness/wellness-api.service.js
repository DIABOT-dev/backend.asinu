'use strict';

const { t } = require('../../i18n');
const wellness = require('./wellness.monitoring.service');

async function withClient(pool, task) {
  const client = await pool.connect();
  try {
    return await task(client);
  } finally {
    client.release();
  }
}

async function logActivityAndEvaluate(pool, userId, activityData) {
  return withClient(pool, async (client) => {
    const activity = await wellness.logUserActivity(
      client,
      userId,
      activityData.activity_type,
      activityData.activity_data,
      activityData.session_id
    );
    const evaluation = await wellness.evaluateUserWellness(pool, userId, {
      executePrompt: false,
      executeAlert: true,
    });
    return { activity, evaluation };
  });
}

async function shouldPrompt(pool, userId) {
  return withClient(pool, (client) => wellness.shouldPromptUser(client, userId));
}

async function sendHelpRequest(pool, userId, message, lang) {
  return withClient(pool, (client) =>
    wellness.sendCaregiverAlert(
      client,
      userId,
      'EMERGENCY',
      t('wellness.help_request_title', lang),
      message || t('wellness.help_request_default', lang),
      'user_request',
      { requestedAt: new Date().toISOString() }
    )
  );
}

module.exports = { logActivityAndEvaluate, shouldPrompt, sendHelpRequest };
