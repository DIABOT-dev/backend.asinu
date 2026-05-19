/**
 * Shared pagination helpers for list endpoints.
 *
 * Two modes:
 *   - parsePagination(req): page/limit (offset-based)
 *   - parseCursor(req): cursor + limit (for large append-only lists)
 *
 * Both clamp limit to MAX_LIMIT so a single client request can never request
 * an unbounded result set.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parsePagination(req) {
  const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const limit = clampLimit(req.query?.limit);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function buildPageResponse(rows, total, { page, limit }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    data: rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    },
  };
}

function parseCursor(req) {
  const limit = clampLimit(req.query?.limit);
  const rawCursor = req.query?.cursor;
  const cursor = rawCursor ? String(rawCursor) : null;
  return { limit, cursor };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parsePagination,
  parseCursor,
  buildPageResponse,
};
