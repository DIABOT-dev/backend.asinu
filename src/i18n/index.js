/**
 * Backend i18n Module
 * Simple translation function for internationalized messages
 * 
 * Usage:
 *   const { t } = require('../i18n');
 *   t('error.server', 'vi')           → 'Lỗi server'
 *   t('error.server', 'en')           → 'Server error'
 *   t('health.glucose_high', 'vi', { value: 300 }) → 'Đường huyết cao bất thường: 300 mg/dL'
 */

const vi = require('./locales/vi.json');
const en = require('./locales/en.json');

const locales = { vi, en };

/**
 * Translate a key to the given language
 * @param {string} key - Translation key (e.g. 'error.server')
 * @param {string} [lang='vi'] - Language code ('vi' or 'en')
 * @param {Object} [params={}] - Interpolation parameters (e.g. { value: 300 })
 * @returns {string} - Translated string
 */
function t(key, lang = 'vi', params = {}) {
  const translations = locales[lang] || locales.vi;
  let text = translations[key] || locales.vi[key] || key;

  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
  }

  return text;
}

/**
 * Get language from request headers
 * @param {Object} req - Express request object
 * @returns {string} - Language code ('vi' or 'en')
 */
function getLang(req) {
  if (!req) return 'vi';
  if (req.lang) return req.lang;
  const acceptLang = req.headers?.['accept-language'] || '';
  return acceptLang.toLowerCase().startsWith('en') ? 'en' : 'vi';
}

module.exports = { t, getLang };
