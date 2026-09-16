const { z } = require('zod');

const cleanText = (maximum) => z.string().trim().max(maximum);

const citationSchema = z
  .object({
    source_id: z.string().uuid(),
    chunk_id: z.string().uuid(),
    quote: z.string().trim().min(1).max(500),
  })
  .strict();

const abnormalFindingSchema = z
  .object({
    metric: z.string().trim().min(1).max(120),
    value: z.union([z.number().finite(), z.string().trim().min(1).max(120)]),
    unit: z.string().trim().max(40),
    observed_at: z.string().datetime().nullable(),
    interpretation: z.string().trim().min(1).max(800),
    source_type: z.enum(['observation', 'checkin', 'symptom', 'rule']),
  })
  .strict();

const soapNoteSchema = z
  .object({
    subjective: cleanText(5000),
    objective: cleanText(5000),
    assessment: cleanText(5000),
    plan: cleanText(5000),
  })
  .strict();

const doctorCopilotOutputSchema = z
  .object({
    patient_reply: cleanText(5000),
    clinical_summary: cleanText(6000),
    clinical_rationale: cleanText(6000),
    clarifying_questions: z.array(z.string().trim().min(1).max(500)).max(6),
    red_flags: z.array(z.string().trim().min(1).max(800)).max(8),
    urgency: z.enum(['routine', 'soon', 'urgent', 'emergency']),
    soap_note: soapNoteSchema,
    abnormal_findings: z.array(abnormalFindingSchema).max(20),
    missing_data: z.array(z.string().trim().min(1).max(500)).max(20),
    conflicts: z.array(z.string().trim().min(1).max(800)).max(20),
    follow_up_draft: cleanText(5000),
    citations: z.array(citationSchema).max(12),
    uncertainties: z.array(z.string().trim().min(1).max(800)).max(12),
    safety_alerts: z.array(z.string().trim().min(1).max(800)).max(12),
  })
  .strict();

const textValue = (value, maximum = 6000) =>
  (typeof value === 'string' ? value.trim() : '').slice(0, maximum);

const textArray = (value, maximumItems, maximumLength = 800) =>
  (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, maximumLength))
    .slice(0, maximumItems);

const normalizeCopilotOutput = (raw) => {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const soap =
    value.soap_note && typeof value.soap_note === 'object' && !Array.isArray(value.soap_note)
      ? value.soap_note
      : {};
  const allowedUrgencies = new Set(['routine', 'soon', 'urgent', 'emergency']);
  return {
    patient_reply: textValue(value.patient_reply || value.draft, 5000),
    clinical_summary: textValue(value.clinical_summary || value.summary, 6000),
    clinical_rationale: textValue(value.clinical_rationale, 6000),
    clarifying_questions: textArray(
      value.clarifying_questions || value.questions,
      6,
      500
    ),
    red_flags: textArray(value.red_flags, 8),
    urgency: allowedUrgencies.has(String(value.urgency)) ? String(value.urgency) : 'routine',
    soap_note: {
      subjective: textValue(soap.subjective, 5000),
      objective: textValue(soap.objective, 5000),
      assessment: textValue(soap.assessment, 5000),
      plan: textValue(soap.plan, 5000),
    },
    abnormal_findings: (Array.isArray(value.abnormal_findings) ? value.abnormal_findings : [])
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        metric: textValue(item.metric, 120),
        value:
          typeof item.value === 'number' && Number.isFinite(item.value)
            ? item.value
            : textValue(item.value, 120),
        unit: textValue(item.unit, 40),
        observed_at:
          typeof item.observed_at === 'string' && !Number.isNaN(Date.parse(item.observed_at))
            ? new Date(item.observed_at).toISOString()
            : null,
        interpretation: textValue(item.interpretation, 800),
        source_type: ['observation', 'checkin', 'symptom', 'rule'].includes(item.source_type)
          ? item.source_type
          : 'observation',
      }))
      .filter((item) => item.metric && item.interpretation && item.value !== '')
      .slice(0, 20),
    missing_data: textArray(value.missing_data, 20, 500),
    conflicts: textArray(value.conflicts, 20),
    follow_up_draft: textValue(value.follow_up_draft, 5000),
    citations: (Array.isArray(value.citations) ? value.citations : [])
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        source_id: textValue(item.source_id, 80),
        chunk_id: textValue(item.chunk_id, 80),
        quote: textValue(item.quote, 500),
      }))
      .slice(0, 12),
    uncertainties: textArray(value.uncertainties, 12),
    safety_alerts: textArray(value.safety_alerts, 12),
  };
};

const normalizeForQuoteMatch = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi');

const validateGroundedCitations = (citations, knowledgeChunks) => {
  const chunks = new Map(
    (knowledgeChunks || []).map((chunk) => [
      `${chunk.source_id}:${chunk.chunk_id}`,
      normalizeForQuoteMatch(chunk.content),
    ])
  );
  const errors = [];
  for (const citation of citations || []) {
    const content = chunks.get(`${citation.source_id}:${citation.chunk_id}`);
    if (!content) {
      errors.push(`Unknown citation ${citation.source_id}/${citation.chunk_id}.`);
      continue;
    }
    if (!content.includes(normalizeForQuoteMatch(citation.quote))) {
      errors.push(`Citation quote is not present in chunk ${citation.chunk_id}.`);
    }
  }
  return errors;
};

module.exports = {
  doctorCopilotOutputSchema,
  normalizeCopilotOutput,
  validateGroundedCitations,
};
