const {
  doctorMessageQuerySchema,
  doctorMessageSendSchema,
  doctorMessageActionSchema,
  doctorVoiceSendSchema,
  doctorAiAssistSchema,
} = require('./doctor-task.policy');
const {
  queryDoctorMessages,
  sendDoctorMessage,
  doctorMessageAction,
  sendDoctorVoice,
} = require('./doctor-messaging.service');
const { createDoctorAiAssist, getDoctorAiContextVersion } = require('./doctor-ai.service');

function validatedDoctorRequest(schema, errorKey, execute) {
  return async (pool, req) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return { ok: false, errorKey, details: parsed.error.issues };
    }
    const data = await execute(pool, req, parsed.data);
    return { ok: true, data };
  };
}

const queryDoctorMessagesRequest = validatedDoctorRequest(
  doctorMessageQuerySchema,
  'error.invalid_message_query',
  queryDoctorMessages
);
const sendDoctorMessageRequest = validatedDoctorRequest(
  doctorMessageSendSchema,
  'error.invalid_doctor_message',
  sendDoctorMessage
);
const doctorMessageActionRequest = validatedDoctorRequest(
  doctorMessageActionSchema,
  'error.invalid_doctor_action',
  doctorMessageAction
);
const sendDoctorVoiceRequest = validatedDoctorRequest(
  doctorVoiceSendSchema,
  'error.invalid_voice_message',
  sendDoctorVoice
);
const createDoctorAiAssistRequest = validatedDoctorRequest(
  doctorAiAssistSchema,
  'error.invalid_ai_request',
  (pool, _req, input) => createDoctorAiAssist(pool, input)
);
const getDoctorAiContextVersionRequest = validatedDoctorRequest(
  doctorAiAssistSchema,
  'error.invalid_ai_context',
  (pool, _req, input) => getDoctorAiContextVersion(pool, input)
);

module.exports = {
  queryDoctorMessagesRequest,
  sendDoctorMessageRequest,
  doctorMessageActionRequest,
  sendDoctorVoiceRequest,
  createDoctorAiAssistRequest,
  getDoctorAiContextVersionRequest,
};
