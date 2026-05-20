/**
 * Chatbot feature gate.
 *
 * Enforces the kill-switch + per-user usage limits required by the MVP
 * audit (FIX #1). Reads everything from env so we can flip the flag
 * without redeploying code.
 *
 *   CHATBOT_ENABLED=false                  -> 403 CHATBOT_DISABLED
 *   CHATBOT_PREMIUM_ONLY=true + not premium-> 403 SUBSCRIPTION_REQUIRED
 *   daily messages   >= limit              -> 429 CHATBOT_DAILY_LIMIT_EXCEEDED
 *   monthly tokens   >= limit              -> 429 CHATBOT_TOKEN_LIMIT_EXCEEDED
 *
 * Anything below the limits passes through to the handler.
 */

const { t, getLang } = require('../i18n');
const { isPremium } = require('../services/payment/subscription.service');
const {
  getDailyMessageCount,
  getMonthlyTokenCount,
} = require('../services/chat/chatbot-usage.service');

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw == null) return def;
  return TRUE_VALUES.has(String(raw).toLowerCase());
}
function envInt(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : def;
}

function chatbotGate(pool) {
  return async function chatbotGateMiddleware(req, res, next) {
    const lang = getLang(req);

    // 1) Global kill switch
    if (!envBool('CHATBOT_ENABLED', true)) {
      return res.status(403).json({
        ok: false,
        code: 'CHATBOT_DISABLED',
        error: t('error.chatbot_disabled', lang) || 'Tính năng chatbot sẽ được mở trong phiên bản sau.',
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: t('error.unauthenticated', lang) });
    }

    // 2) Premium-only gate
    let premium = false;
    try {
      premium = await isPremium(pool, userId);
    } catch (_err) {
      // If subscription lookup fails, treat as not-premium so we err on the safe side.
      premium = false;
    }

    if (envBool('CHATBOT_PREMIUM_ONLY', false) && !premium) {
      return res.status(403).json({
        ok: false,
        code: 'SUBSCRIPTION_REQUIRED',
        error: t('error.chatbot_premium_only', lang) || 'Chatbot hiện chỉ dành cho gói Premium.',
      });
    }

    // 3) Daily message limit
    const dailyLimit = premium
      ? envInt('CHATBOT_DAILY_LIMIT_PREMIUM', 20)
      : envInt('CHATBOT_DAILY_LIMIT_FREE', 0);

    if (dailyLimit > 0) {
      const used = await getDailyMessageCount(pool, userId);
      if (used >= dailyLimit) {
        return res.status(429).json({
          ok: false,
          code: 'CHATBOT_DAILY_LIMIT_EXCEEDED',
          error: t('error.chatbot_daily_limit', lang) || `Bạn đã đạt giới hạn ${dailyLimit} tin nhắn hôm nay.`,
          daily_limit: dailyLimit,
          daily_used: used,
        });
      }
      req.chatbotDailyUsage = { used, limit: dailyLimit };
    } else if (dailyLimit === 0) {
      // Limit of 0 means "blocked" for that tier (e.g. free users when PREMIUM_ONLY=false).
      return res.status(429).json({
        ok: false,
        code: 'CHATBOT_DAILY_LIMIT_EXCEEDED',
        error: t('error.chatbot_daily_limit_zero', lang) || 'Tính năng chatbot không khả dụng cho gói hiện tại.',
        daily_limit: 0,
      });
    }

    // 4) Monthly token budget
    const monthlyLimit = premium
      ? envInt('CHATBOT_MONTHLY_TOKEN_LIMIT_PREMIUM', 200000)
      : envInt('CHATBOT_MONTHLY_TOKEN_LIMIT_FREE', 0);

    if (monthlyLimit > 0) {
      const used = await getMonthlyTokenCount(pool, userId);
      if (used >= monthlyLimit) {
        return res.status(429).json({
          ok: false,
          code: 'CHATBOT_TOKEN_LIMIT_EXCEEDED',
          error: t('error.chatbot_token_limit', lang) || 'Bạn đã đạt giới hạn token chatbot trong tháng.',
          monthly_token_limit: monthlyLimit,
          monthly_token_used: used,
        });
      }
      req.chatbotMonthlyUsage = { used, limit: monthlyLimit };
    }

    return next();
  };
}

module.exports = { chatbotGate };
