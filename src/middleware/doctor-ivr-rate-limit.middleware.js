'use strict';
const rateLimit = require('express-rate-limit');
function createOperationLimiter(operation, limitCount, code, error) {
  const limit = rateLimit({
    windowMs: 60000,
    limit: limitCount,
    keyGenerator: (req) => `${req.body?.tenant_id}:${req.body?.doctor_id}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, code, error },
  });
  return (req, res, next) => (req.body?.operation === operation ? limit(req, res, next) : next());
}
const createDoctorIvrGenerationLimiter = () =>
  createOperationLimiter(
    'generate',
    5,
    'IVR_RATE_LIMIT',
    'Bạn đã tạo nhiều bộ câu hỏi. Vui lòng thử lại sau một phút.'
  );
const createDoctorIvrPreviewLimiter = () =>
  createOperationLimiter(
    'preview',
    12,
    'IVR_PREVIEW_RATE_LIMIT',
    'Bạn đã nghe thử nhiều lần. Vui lòng thử lại sau một phút.'
  );
const createDoctorIvrDictationLimiter = () =>
  createOperationLimiter(
    'dictate',
    6,
    'IVR_DICTATION_RATE_LIMIT',
    'Bạn đã nhập bằng giọng nói nhiều lần. Vui lòng thử lại sau một phút.'
  );
const createDoctorIvrReplyDraftLimiter = () =>
  createOperationLimiter(
    'draft_reply',
    5,
    'IVR_REPLY_DRAFT_RATE_LIMIT',
    'Bạn đã tạo nhiều bản nháp trả lời. Vui lòng thử lại sau một phút.'
  );
module.exports = {
  createDoctorIvrGenerationLimiter,
  createDoctorIvrPreviewLimiter,
  createDoctorIvrDictationLimiter,
  createDoctorIvrReplyDraftLimiter,
};
