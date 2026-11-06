'use strict';

// Check cardinality before schema validation allocates an issue per bad element.
// Strings remain governed by the HTTP body limit (including base64 uploads).
function withinJsonBudget(root) {
  const stack = [[root, 0]];
  let remaining = 20000;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (--remaining < 0 || depth > 32) return false;
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value) && value.length > 10000) return false;
    const keys = Object.keys(value);
    if (keys.length > (Array.isArray(value) ? 10000 : 1000)) return false;
    if (keys.length > remaining) return false;
    for (const key of keys) stack.push([value[key], depth + 1]);
  }
  return true;
}

function limitJsonComplexity(req, _res, next) {
  if (withinJsonBudget(req.body) && withinJsonBudget(req.query)) return next();
  const error = new Error('Request data exceeds the supported structure limits.');
  error.statusCode = 413;
  error.code = 'INVALID_INPUT';
  return next(error);
}

module.exports = { withinJsonBudget, limitJsonComplexity };
