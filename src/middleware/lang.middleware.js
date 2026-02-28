/**
 * Language Detection Middleware
 * Reads Accept-Language header and sets req.lang
 */

function langMiddleware(req, res, next) {
  const acceptLang = req.headers['accept-language'] || '';
  req.lang = acceptLang.toLowerCase().startsWith('en') ? 'en' : 'vi';
  next();
}

module.exports = langMiddleware;
