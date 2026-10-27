// Explicit operator command only. Sends one synthetic event, no patient data.
require('dotenv').config({ quiet: true });
const monitor = require('../src/lib/sentry');
(async () => {
  if (!monitor.initSentry(process.env.SENTRY_SERVICE || 'asinu-backend')) {
    console.log(JSON.stringify({ enabled: false, accepted: false }));
    process.exitCode = 2;
    return;
  }
  let statusCode;
  require('@sentry/node')
    .getClient()
    .on('afterSendEvent', (_event, response) => {
      statusCode = response && response.statusCode;
    });
  const error = new Error('Synthetic deployment verification');
  error.name = 'SentryDeploymentCheckError';
  const eventId = monitor.captureException(error, { operation: 'deployment_check' });
  const flushed = await monitor.flushSentry(5000);
  const accepted = Boolean(flushed && statusCode >= 200 && statusCode < 300);
  console.log(JSON.stringify({ enabled: true, eventId, flushed, statusCode, accepted }));
  if (!accepted) process.exitCode = 1;
})().catch(() => {
  console.log(JSON.stringify({ accepted: false }));
  process.exitCode = 1;
});
