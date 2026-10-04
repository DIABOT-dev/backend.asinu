const {
  loadPatientProfile,
  createPatientFile,
} = require('../services/integrations/doctor-profile.service');
const { ingestDoctorLifecycle } = require('../services/integrations/doctor-lifecycle.service');
const requests = require('../services/integrations/doctor-profile-request.service');
const { getLang, t } = require('../i18n');

const getDoctorPatientProfile = async (pool, req, res) => {
  const profile = await loadPatientProfile(pool, req);
  return res.status(200).json({ ok: true, data: profile });
};

const createDoctorPatientFile = async (pool, req, res) => {
  const data = await createPatientFile(pool, req);
  return res.status(201).json({ ok: true, data });
};

const ingestDoctorPatientLifecycle = async (pool, req, res) => {
  const data = await ingestDoctorLifecycle(pool, req);
  return res.status(data.duplicate ? 200 : 201).json({ ok: true, data });
};

function doctorRequestHandler(requestService, createsResource = false) {
  return async (pool, req, res) => {
    const result = await requestService(pool, req);
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: t(result.errorKey, getLang(req)),
        details: result.details,
      });
    }
    const status = createsResource && !result.data.duplicate ? 201 : 200;
    return res.status(status).json({ ok: true, data: result.data });
  };
}

const queryDoctorMessages = doctorRequestHandler(requests.queryDoctorMessagesRequest);
const sendDoctorMessage = doctorRequestHandler(requests.sendDoctorMessageRequest, true);
const doctorMessageAction = doctorRequestHandler(requests.doctorMessageActionRequest);
const sendDoctorVoice = doctorRequestHandler(requests.sendDoctorVoiceRequest, true);
const createDoctorAiAssist = doctorRequestHandler(requests.createDoctorAiAssistRequest);
const getDoctorAiContextVersion = doctorRequestHandler(requests.getDoctorAiContextVersionRequest);

module.exports = {
  getDoctorPatientProfile,
  createDoctorPatientFile,
  ingestDoctorPatientLifecycle,
  queryDoctorMessages,
  sendDoctorMessage,
  doctorMessageAction,
  sendDoctorVoice,
  createDoctorAiAssist,
  getDoctorAiContextVersion,
};
