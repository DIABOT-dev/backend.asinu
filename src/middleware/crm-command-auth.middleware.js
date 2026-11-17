'use strict';
const crypto = require('crypto');
function requireCrmCommand(req, res, next) {
  const secret = process.env.CRM_APP_BACKEND_SECRET,
    time = req.get('x-crm-timestamp');
  const signature = (req.get('x-crm-signature') || '').replace(/^sha256=/, '');
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = secret
    ? crypto
        .createHmac('sha256', secret)
        .update(`${time}.${raw.toString('utf8')}`)
        .digest('hex')
    : '';
  if (
    !secret ||
    !time ||
    !/^\d+$/.test(time) ||
    Math.abs(Date.now() / 1000 - Number(time)) > 300 ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  )
    return res.status(401).json({ ok: false, code: 'INVALID_CRM_SIGNATURE' });
  return next();
}
module.exports = { requireCrmCommand };
