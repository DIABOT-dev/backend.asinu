'use strict';
const crypto = require('node:crypto');
const tokenHash = (token) =>
  typeof token === 'string' && token.length
    ? crypto.createHash('sha256').update(token).digest('hex')
    : null;
function compatibleDeviceTokens(user) {
  return {
    fcm:
      user?.fcm_token && user.doctor_ivr_fcm_hash === tokenHash(user.fcm_token)
        ? user.fcm_token
        : null,
    voip:
      user?.voip_push_token && user.doctor_ivr_voip_hash === tokenHash(user.voip_push_token)
        ? user.voip_push_token
        : null,
  };
}
module.exports = { tokenHash, compatibleDeviceTokens };
