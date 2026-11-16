'use strict';
const care = require('../services/integrations/doctor-care.service');
const { careEvent } = require('../services/integrations/doctor-care-events.service');
const respond = (handler) => async (pool, req, res) => res.json(await handler(pool, req));
module.exports = {
  patientCare: respond(care.patientCare),
  patientCredits: respond(care.patientCredits),
  reconsultationContext: respond(care.reconsultationContext),
  cancelPatientTask: respond(care.cancelPatientTask),
  careEvent: respond(careEvent),
};
