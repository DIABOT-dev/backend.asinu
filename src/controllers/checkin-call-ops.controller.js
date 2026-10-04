const ops = require('../services/checkin-call/ops.service');
const { t, getLang } = require('../i18n');
const logger = require('../lib/logger');

function createCheckinCallOpsController(pool) {
  return {
    async metrics(req, res) {
      try {
        return res.json({ ok: true, ...(await ops.getMetrics(pool)) });
      } catch (error) {
        logger.error('checkin_call.metrics_failed', { err: error });
        return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
      }
    },

    async exhausted(req, res) {
      try {
        return res.json({ ok: true, episodes: await ops.listExhausted(pool, req.query.limit) });
      } catch (error) {
        logger.error('checkin_call.exhausted_list_failed', { err: error });
        return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
      }
    },

    async timeline(req, res) {
      try {
        return res.json({ ok: true, events: await ops.getEpisodeTimeline(pool, req.params.id) });
      } catch (error) {
        logger.error('checkin_call.timeline_failed', { episodeId: req.params.id, err: error });
        return res.status(500).json({ ok: false, error: t('error.server', getLang(req)) });
      }
    },
  };
}

module.exports = { createCheckinCallOpsController };
