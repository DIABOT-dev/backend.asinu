'use strict';

const { isHealthFeedEnabled } = require('./config');
const { t, getLang } = require('../../i18n');
const repo = require('./repository');
const service = require('./service');
const { z } = require('zod');
const { parsePageLimit, pageResult } = require('../../lib/list-pagination');

const savedCursor = z.object({ id: z.string().min(1).max(256), time: z.iso.datetime() }).strict();
const feedCursor = savedCursor.extend({
  id: z.uuid(),
  priority: z.number().int().min(-2147483648).max(2147483647),
});

function readPage(query, cursorSchema) {
  if (query.limit === undefined && query.before === undefined) return null;
  const limit = parsePageLimit(query.limit, 10);
  if (query.before === undefined) return { limit, before: null };
  const encoded = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/).parse(query.before);
  const before = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString()));
  return { limit, before };
}

function pagedResponse(rows, limit, field, withPriority) {
  const { items, nextBefore } = pageResult(rows, limit, (row) => {
    const cursor = { id: row.id, time: row.cursor_time, ...(withPriority ? { priority: row.priority } : {}) };
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  });
  return { [field]: items.map(({ cursor_time: _cursorTime, ...row }) => row), nextBefore };
}

function invalidPage(req, res) {
  return res.status(400).json({ ok: false, error: t('error.invalid_data', getLang(req)) });
}

function disabledResponse(res) {
  return res.status(200).json({ ok: true, enabled: false });
}

async function getFeed(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  let page;
  try { page = readPage(req.query || {}, feedCursor); }
  catch { return invalidPage(req, res); }
  const result = await service.ensureUserFeed(pool, req.user.id, page && { ...page, limit: page.limit + 1 });
  return res.json({ ok: true, enabled: true, ...(page
    ? pagedResponse(result.feed, page.limit, 'feed', true)
    : { feed: result.feed }) });
}

async function markFeedRead(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  const ok = await repo.markRead(pool, req.user.id, req.params.id);
  return res.status(ok ? 200 : 404).json({ ok });
}

async function dismissFeed(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  const ok = await repo.dismiss(pool, req.user.id, req.params.id);
  return res.status(ok ? 200 : 404).json({ ok });
}

async function getContent(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  const content = await repo.getContent(pool, req.user.id, req.params.id);
  if (!content) {
    return res.status(404).json({
      ok: false,
      error: t('health_feed.content_not_found', getLang(req)),
    });
  }
  return res.json({ ok: true, enabled: true, content });
}

async function saveContent(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  await repo.saveContent(pool, req.user.id, req.params.id);
  return res.json({ ok: true, enabled: true });
}

async function unsaveContent(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  await repo.unsaveContent(pool, req.user.id, req.params.id);
  return res.json({ ok: true, enabled: true });
}

async function getSaved(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  let page;
  try { page = readPage(req.query || {}, savedCursor); }
  catch { return invalidPage(req, res); }
  const saved = await repo.listSaved(pool, req.user.id, page && { ...page, limit: page.limit + 1 });
  return res.json({ ok: true, enabled: true, ...(page
    ? pagedResponse(saved, page.limit, 'saved', false)
    : { saved }) });
}

async function createEvent(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  const { content_id, feed_item_id, event_type, metadata } = req.body || {};
  if (!content_id || !event_type) {
    return res.status(400).json({
      ok: false,
      error: t('health_feed.event_fields_required', getLang(req)),
    });
  }
  await repo.trackEvent(pool, req.user.id, { content_id, feed_item_id, event_type, metadata });
  return res.json({ ok: true, enabled: true });
}

module.exports = {
  createEvent,
  dismissFeed,
  getContent,
  getFeed,
  getSaved,
  markFeedRead,
  saveContent,
  unsaveContent,
};
