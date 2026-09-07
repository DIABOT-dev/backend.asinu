const express = require('express');
const { getDoctorPatientProfile } = require('../controllers/doctor-profile.controller');
const {
  createPatientFile,
  verifyDoctorSignature,
} = require('../services/integrations/doctor-profile.service');
const {
  doctorMessageQuerySchema,
  doctorMessageSendSchema,
  doctorAiAssistSchema,
} = require('../services/integrations/doctor-task.policy');
const {
  queryDoctorMessages,
  sendDoctorMessage,
} = require('../services/integrations/doctor-messaging.service');
const { createDoctorAiAssist } = require('../services/integrations/doctor-ai.service');
const { ingestDoctorLifecycle } = require('../services/integrations/doctor-lifecycle.service');

function doctorProfileRoutes(pool) {
  const router = express.Router();
  const requireDoctorSignature = (req, _res, next) => {
    try {
      verifyDoctorSignature(req);
      return next();
    } catch (error) {
      return next(error);
    }
  };
  router.post('/profile', (req, res, next) =>
    Promise.resolve(getDoctorPatientProfile(pool, req, res)).catch(next)
  );
  router.post('/patient-files', (req, res, next) =>
    Promise.resolve(createPatientFile(pool, req))
      .then((data) => res.status(201).json({ ok: true, data }))
      .catch(next)
  );
  router.post('/lifecycle', (req, res, next) =>
    Promise.resolve(ingestDoctorLifecycle(pool, req))
      .then((data) => res.status(data.duplicate ? 200 : 201).json({ ok: true, data }))
      .catch(next)
  );
  router.post('/messages/query', requireDoctorSignature, (req, res, next) => {
    const parsed = doctorMessageQuerySchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid message query.', details: parsed.error.issues });
    return Promise.resolve(queryDoctorMessages(pool, req, parsed.data))
      .then((data) => res.json({ ok: true, data }))
      .catch(next);
  });
  router.post('/messages/send', requireDoctorSignature, (req, res, next) => {
    const parsed = doctorMessageSendSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid Doctor message.', details: parsed.error.issues });
    return Promise.resolve(sendDoctorMessage(pool, req, parsed.data))
      .then((data) => res.status(data.duplicate ? 200 : 201).json({ ok: true, data }))
      .catch(next);
  });
  router.post('/ai-assist', requireDoctorSignature, (req, res, next) => {
    const parsed = doctorAiAssistSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid Doctor AI request.', details: parsed.error.issues });
    return Promise.resolve(createDoctorAiAssist(pool, parsed.data))
      .then((data) => res.json({ ok: true, data }))
      .catch(next);
  });
  return router;
}

module.exports = doctorProfileRoutes;
