'use strict';

const { isHealthFeedEnabled } = require('./config');
const repo = require('./repository');
const service = require('./service');

function disabledResponse(res) {
  return res.status(200).json({ ok: true, enabled: false });
}

async function getFeed(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  const result = await service.ensureUserFeed(pool, req.user.id);
  return res.json({ ok: true, enabled: true, feed: result.feed });
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
  if (!content) return res.status(404).json({ ok: false, error: 'Content not found' });
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
  const saved = await repo.listSaved(pool, req.user.id);
  return res.json({ ok: true, enabled: true, saved });
}

async function createEvent(pool, req, res) {
  if (!isHealthFeedEnabled()) return disabledResponse(res);
  const { content_id, feed_item_id, event_type, metadata } = req.body || {};
  if (!content_id || !event_type) {
    return res.status(400).json({ ok: false, error: 'content_id and event_type are required' });
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
