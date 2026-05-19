const { parsePagination, parseCursor, buildPageResponse, MAX_LIMIT } = require('../../src/lib/pagination');

describe('parsePagination', () => {
  test('returns defaults for empty query', () => {
    const r = parsePagination({ query: {} });
    expect(r.page).toBe(1);
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(0);
  });

  test('clamps page to min 1', () => {
    const r = parsePagination({ query: { page: '-5' } });
    expect(r.page).toBe(1);
  });

  test('clamps limit to MAX_LIMIT', () => {
    const r = parsePagination({ query: { limit: '99999' } });
    expect(r.limit).toBe(MAX_LIMIT);
  });

  test('computes correct offset', () => {
    const r = parsePagination({ query: { page: '3', limit: '50' } });
    expect(r.offset).toBe(100);
  });

  test('falls back to default on garbage limit', () => {
    const r = parsePagination({ query: { limit: 'abc' } });
    expect(r.limit).toBe(20);
  });
});

describe('buildPageResponse', () => {
  test('exposes has_next/has_prev correctly', () => {
    const r = buildPageResponse([{ id: 1 }], 100, { page: 2, limit: 20 });
    expect(r.pagination.total_pages).toBe(5);
    expect(r.pagination.has_next).toBe(true);
    expect(r.pagination.has_prev).toBe(true);
  });

  test('handles last page', () => {
    const r = buildPageResponse([{ id: 1 }], 100, { page: 5, limit: 20 });
    expect(r.pagination.has_next).toBe(false);
    expect(r.pagination.has_prev).toBe(true);
  });
});

describe('parseCursor', () => {
  test('extracts cursor and limit', () => {
    const r = parseCursor({ query: { cursor: 'abc123', limit: '30' } });
    expect(r.cursor).toBe('abc123');
    expect(r.limit).toBe(30);
  });

  test('returns null cursor when missing', () => {
    const r = parseCursor({ query: {} });
    expect(r.cursor).toBeNull();
  });
});
