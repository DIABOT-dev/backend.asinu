'use strict';
const purpose = require('../services/v21/medication-purpose.service');
module.exports = (pool) => ({
  lookup: async (req, res) =>
    res.json({
      ok: true,
      ...(await purpose.lookup(pool, req.user.id, req.query.patientId, req.body)),
    }),
});
