'use strict';

const { z } = require('zod');

const pageLimit = z.union([z.number(), z.string().regex(/^\d{1,2}$/).transform(Number)])
  .pipe(z.number().int().min(1).max(30));

function parsePageLimit(value, fallback) {
  return value === undefined ? fallback : pageLimit.parse(value);
}

function pageResult(rows, limit, makeCursor) {
  const items = rows.slice(0, limit);
  return { items, nextBefore: rows.length > limit ? makeCursor(items.at(-1)) : null };
}

module.exports = { parsePageLimit, pageResult };
