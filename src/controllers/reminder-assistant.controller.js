'use strict';

const skill = require('../services/notification/reminder-assistant.service');
const { hasAiConsent } = require('../services/ai/ai-consent.service');
const { getLang } = require('../i18n');

const messages = {
  REMINDER_ASSISTANT_DISABLED: ['Chức năng cài giờ bằng lời nói chưa được bật.', 'Reminder assistant is not enabled.'],
  REMINDER_ASSISTANT_INVALID_TEXT: ['Bạn nhập yêu cầu đổi giờ nhắc, tối đa 6.000 ký tự nhé.', 'Enter a reminder request of up to 6,000 characters.'],
  REMINDER_ASSISTANT_REMINDERS_OFF: ['Bạn bật nhắc nhở trước khi đổi giờ nhé.', 'Turn on reminders before changing their times.'],
  REMINDER_ASSISTANT_EXPIRED: ['Yêu cầu đã hết hạn. Bạn gửi lại để Asinu kiểm tra giờ hiện tại nhé.', 'This request expired. Send it again to check the current times.'],
  REMINDER_ASSISTANT_CONFLICT: ['Giờ nhắc vừa được thay đổi. Bạn xem lịch hiện tại rồi gửi lại nhé.', 'Reminder times changed. Review the current schedule and try again.'],
  REMINDER_ASSISTANT_UNAVAILABLE: ['Chưa xác nhận được kết quả. Bạn xem giờ nhắc hiện tại và thử lại nhé.', 'Could not confirm the result. Check your current reminder times and try again.'],
};

async function requireReminderAssistant(pool, req, res, next) {
  if (!skill.enabled()) return res.status(404).json({ ok: false, code: 'REMINDER_ASSISTANT_DISABLED' });
  try {
    // This new entry point always requires a receipt, including legacy rollout.
    if (!(await hasAiConsent(pool, req.user.id))) return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
    return next();
  } catch (error) { return next(error); }
}

function handler(operation) {
  return async (pool, req, res) => {
    const lang = getLang(req);
    try {
      let result;
      if (operation === 'plan') {
        if (!req.body || Object.keys(req.body).some(key => key !== 'text'))
          throw Object.assign(new Error(), { code: 'REMINDER_ASSISTANT_INVALID_TEXT', statusCode: 400 });
        result = await skill.plan(pool, req.user.id, req.body.text, lang);
        if (!(await hasAiConsent(pool, req.user.id))) return res.status(403).json({ ok: false, code: 'AI_CONSENT_REQUIRED' });
      } else {
        if (!req.body || typeof req.body.token !== 'string' || req.body.token.length > 5000 ||
          Object.keys(req.body).some(key => key !== 'token'))
          throw Object.assign(new Error(), { code: 'REMINDER_ASSISTANT_EXPIRED', statusCode: 400 });
        result = await skill.execute(pool, req.user.id, req.body.token);
      }
      return res.json({ ok: true, ...result });
    } catch (error) {
      const code = Object.hasOwn(messages, error.code) ? error.code : 'REMINDER_ASSISTANT_UNAVAILABLE';
      return res.status(error.statusCode || 503).json({ ok: false, code, error: messages[code][lang === 'en' ? 1 : 0] });
    }
  };
}

module.exports = { requireReminderAssistant, plan: handler('plan'), apply: handler('apply') };
