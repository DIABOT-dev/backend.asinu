const express = require('express');
const { getDoctorPatientProfile } = require('../controllers/doctor-profile.controller');
const { createPatientFile } = require('../services/integrations/doctor-profile.service');

function doctorProfileRoutes(pool) {
  const router = express.Router();
  router.post('/profile', (req, res, next) =>
    Promise.resolve(getDoctorPatientProfile(pool, req, res)).catch(next)
  );
  router.post('/patient-files', (req, res, next) =>
    Promise.resolve(createPatientFile(pool, req)).then((data) => res.status(201).json({ ok: true, data })).catch(next)
  );
  return router;
}

module.exports = doctorProfileRoutes;
