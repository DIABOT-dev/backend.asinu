'use strict';
const { z } = require('zod');
const { getLang, t } = require('../i18n');
const gifts = require('../services/checkin-gifts/gift.service');
const admin = require('../services/checkin-gifts/gift-admin.service');
const draw = require('../services/checkin-gifts/draw.service');
const id = (value) =>
  z
    .string()
    .regex(/^\d{1,18}$/)
    .parse(value);
const handle = (work) => async (req, res) => {
  try {
    return await work(req, res);
  } catch (error) {
    return res.status(error instanceof z.ZodError ? 400 : error.statusCode || 503).json({
      ok: false,
      code:
        error instanceof z.ZodError
          ? 'INVALID_GIFT_REQUEST'
          : error.statusCode
            ? error.code
            : 'GIFT_UNAVAILABLE',
      error: t('error.server', getLang(req)),
    });
  }
};
const json = (work) => handle(async (req, res) => res.json({ ok: true, ...(await work(req)) }));
function createGiftController(pool) {
  return {
    receipt: json((req) => gifts.receipt(pool, req.user.id, req.params.id, getLang(req))),
    today: json((req) => gifts.today(pool, req.user.id, getLang(req))),
    open: json(async (req) => ({
      gift: await gifts.open(pool, req.user.id, req.body?.gift_id, req.body?.box, getLang(req)),
    })),
    history: json((req) => gifts.history(pool, req.user.id, req.query.before, getLang(req))),
    rules: json((req) => gifts.rules(pool, id(req.params.id), getLang(req))),
    results: json((req) => draw.results(pool, id(req.params.id))),
    config: json(() => admin.getConfig(pool)),
    saveConfig: json((req) => admin.saveConfig(pool, req.body)),
    locs: json(() => admin.listLocs(pool)),
    saveLoc: json((req) => admin.saveLoc(pool, req.params.code, req.body)),
    saveDraw: json((req) => admin.saveDraw(pool, req.params.code, req.body)),
    publish: json((req) => admin.publish(pool, req.params.id, req.body)),
    exportTickets: handle(async (req, res) =>
      res
        .type('text/csv')
        .attachment(`draw-${id(req.params.id)}-tickets.csv`)
        .send(await admin.exportTickets(pool, req.params.id))
    ),
  };
}
module.exports = { createGiftController };
