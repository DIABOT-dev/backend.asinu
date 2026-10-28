'use strict';
const rateLimit = require('express-rate-limit');
function createDoctorIvrGenerationLimiter() {
  const limit = rateLimit({
    windowMs: 60000,
    limit: 5,
    keyGenerator: (req) => `${req.body?.tenant_id}:${req.body?.doctor_id}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      ok: false,
      code: 'IVR_RATE_LIMIT',
      error: 'Bạn đã tạo nhiều bộ câu hỏi. Vui lòng thử lại sau một phút.',
    },
  });
  return (req, res, next) => (req.body?.operation === 'generate' ? limit(req, res, next) : next());
}
module.exports = { createDoctorIvrGenerationLimiter };
