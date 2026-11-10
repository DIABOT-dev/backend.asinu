'use strict';
const medication = require('../services/v21/medication.service');
module.exports = (pool) => ({
  moveItem: async (req, res) =>
    res.json({
      ok: true,
      ...(await medication.moveItem(
        pool,
        req.user.id,
        req.query.patientId,
        req.params.id,
        req.body
      )),
    }),
});
