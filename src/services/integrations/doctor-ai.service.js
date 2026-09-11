const { callTextAi } = require('../ai/ai.service');
const { filterAiOutput } = require('../ai/ai-safety.service');
const { assertTenantAllowed } = require('./doctor-task.service');
const { assertProfileRequest } = require('./doctor-profile.service');

const integrationError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const loadDoctorRagContext = async (pool, input) => {
  const { tenantId, appUserId, taskId } = assertProfileRequest(input);
  assertTenantAllowed(tenantId);
  const task = await pool.query(
    `SELECT payload->'payload'->>'app_user_id' AS app_user_id
       FROM doctor_task_outbox
      WHERE tenant_id = $1
        AND payload->>'event_type' = 'doctor.task.requested'
        AND payload->'payload'->>'task_id' = $2
      LIMIT 1`,
    [tenantId, taskId]
  );
  if (!task.rows[0] || task.rows[0].app_user_id !== appUserId) {
    throw integrationError(404, 'DOCTOR_TASK_NOT_FOUND', 'The Doctor task was not found.');
  }

  const [profile, bloodPressure, glucose, medication, symptoms, records] = await Promise.all([
    pool.query(
      `SELECT p.birth_year, p.gender, COALESCE(p.medical_conditions, '[]'::jsonb) AS conditions,
              COALESCE(p.chronic_symptoms, '[]'::jsonb) AS chronic_symptoms,
              COALESCE(p.raw_profile->'allergies', '[]'::jsonb) AS allergies
         FROM user_onboarding_profiles p WHERE p.user_id = $1`,
      [appUserId]
    ),
    pool.query(
      `SELECT logs.systolic, logs.diastolic, logs.pulse, common.occurred_at
         FROM logs_common common JOIN blood_pressure_logs logs ON logs.log_id = common.id
        WHERE common.user_id = $1 ORDER BY common.occurred_at DESC LIMIT 20`,
      [appUserId]
    ),
    pool.query(
      `SELECT logs.value, logs.unit, logs.context, logs.meal_tag, common.occurred_at
         FROM logs_common common JOIN glucose_logs logs ON logs.log_id = common.id
        WHERE common.user_id = $1 ORDER BY common.occurred_at DESC LIMIT 20`,
      [appUserId]
    ),
    pool.query(
      `SELECT logs.med_name, logs.dose_text, logs.frequency_text, common.occurred_at
         FROM logs_common common JOIN medication_logs logs ON logs.log_id = common.id
        WHERE common.user_id = $1 ORDER BY common.occurred_at DESC LIMIT 20`,
      [appUserId]
    ),
    pool.query(
      `SELECT symptom_name, severity, occurred_date FROM symptom_logs
        WHERE user_id = $1 ORDER BY occurred_date DESC LIMIT 20`,
      [appUserId]
    ),
    pool.query(
      `SELECT record_type, diagnosis, summary, treatment, recorded_at
         FROM doctor_patient_medical_records WHERE user_id = $1
        ORDER BY recorded_at DESC LIMIT 20`,
      [appUserId]
    ),
  ]);
  return {
    profile: profile.rows[0] || {},
    blood_pressure: bloodPressure.rows,
    glucose: glucose.rows,
    medications: medication.rows,
    symptoms: symptoms.rows,
    medical_records: records.rows,
  };
};

const touchpointInstruction = {
  patient_summary: 'Summarize the clinically relevant context for the assigned doctor.',
  suggested_questions: 'Draft 3 to 6 concise follow-up questions for the doctor to review.',
  consultation_draft:
    'Draft a patient-facing consultation response for the doctor to edit and approve.',
  auto_triage: 'Provide provisional urgency, red flags and recommended next clinical workflow.',
};

const parseModelJson = (content) => {
  const text = String(content || '').trim();
  const candidates = [
    text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim(),
  ];
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject)
    candidates.push(text.slice(firstObject, lastObject + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next normalized candidate before rejecting the provider output.
    }
  }

  throw integrationError(
    502,
    'DOCTOR_AI_INVALID_RESPONSE',
    'The AI provider returned invalid JSON.'
  );
};

const sanitizeModelOutput = (value) => {
  if (typeof value === 'string') return filterAiOutput(value).text;
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeModelOutput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => [key, sanitizeModelOutput(item)])
    );
  }
  return value;
};

const createDoctorAiAssist = async (pool, input) => {
  const context = await loadDoctorRagContext(pool, input);
  const localeInstruction = input.locale === 'en' ? 'Write in English.' : 'Write in Vietnamese.';
  let response;
  try {
    response = await callTextAi({
      system: `You are a clinical decision-support assistant for licensed doctors. You do not diagnose, prescribe, or send content directly to patients. Use only the supplied context. Mark uncertainty, identify emergency red flags, avoid definitive claims, and return JSON only. ${localeInstruction}`,
      prompt: JSON.stringify({
        task: input.task_summary,
        request: touchpointInstruction[input.touchpoint],
        context,
        output_contract: {
          draft: 'string suitable for doctor review',
          summary: 'short clinical rationale',
          questions: ['optional question'],
          red_flags: ['optional red flag'],
          urgency: 'routine|soon|urgent|emergency',
          sources: [
            'ASINU profile',
            'blood pressure log',
            'glucose log',
            'medication log',
            'medical record',
          ],
        },
      }),
      temperature: 0.2,
      maxTokens: 1000,
      jsonMode: true,
      // Doctor triage requires strict JSON. Keep this provider independent
      // from the general clinical provider so MedGemma can remain enabled for
      // other ASINU flows without breaking the Doctor contract.
      provider: process.env.DOCTOR_AI_PROVIDER || 'openai',
    });
  } catch (error) {
    throw integrationError(
      503,
      'DOCTOR_AI_PROVIDER_UNAVAILABLE',
      error instanceof Error ? error.message : 'The clinical AI provider is unavailable.'
    );
  }
  const output = sanitizeModelOutput(parseModelJson(response.content));
  return {
    ...output,
    touchpoint: input.touchpoint,
    provider: response.provider,
    model: response.model,
    disclaimer:
      input.locale === 'en'
        ? 'AI-generated decision support. A licensed doctor must review and approve it.'
        : 'Nội dung hỗ trợ do AI tạo. Bác sĩ có giấy phép phải kiểm tra và phê duyệt.',
  };
};

module.exports = { createDoctorAiAssist, loadDoctorRagContext };
