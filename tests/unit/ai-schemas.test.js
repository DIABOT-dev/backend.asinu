const {
  safeValidate,
  RiskAssessmentSchema,
  TriageActionSchema,
  SymptomAnalysisSchema,
} = require('../../src/lib/ai-schemas');

describe('safeValidate', () => {
  test('parses plain JSON string', () => {
    const raw = JSON.stringify({
      risk_tier: 'LOW',
      risk_score: 10,
      notify_caregiver: false,
      reasoning: 'ok',
      outcome_text: 'fine',
      recommended_action: 'rest',
    });
    const r = safeValidate(RiskAssessmentSchema, raw);
    expect(r.ok).toBe(true);
  });

  test('extracts JSON from code fence', () => {
    const raw = '```json\n{"risk_tier":"LOW","risk_score":10,"notify_caregiver":false,"reasoning":"ok","outcome_text":"fine","recommended_action":"rest"}\n```';
    const r = safeValidate(RiskAssessmentSchema, raw);
    expect(r.ok).toBe(true);
  });

  test('extracts JSON when surrounded by prose', () => {
    const raw = 'Here is my assessment: {"risk_tier":"HIGH","risk_score":80,"notify_caregiver":true,"reasoning":"chest pain","outcome_text":"go to ER","recommended_action":"call 115"} -- end';
    const r = safeValidate(RiskAssessmentSchema, raw);
    expect(r.ok).toBe(true);
    expect(r.data.risk_tier).toBe('HIGH');
  });

  test('rejects bad JSON', () => {
    const r = safeValidate(RiskAssessmentSchema, 'not json at all');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_json');
  });

  test('rejects invalid risk_tier', () => {
    const r = safeValidate(RiskAssessmentSchema, JSON.stringify({
      risk_tier: 'SOMETHING_ELSE',
      risk_score: 50,
      notify_caregiver: false,
      reasoning: 'x',
      outcome_text: 'y',
      recommended_action: 'z',
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('schema_mismatch');
  });

  test('rejects out-of-range risk_score', () => {
    const r = safeValidate(RiskAssessmentSchema, {
      risk_tier: 'LOW',
      risk_score: 200,
      notify_caregiver: false,
      reasoning: 'x',
      outcome_text: 'y',
      recommended_action: 'z',
    });
    expect(r.ok).toBe(false);
  });
});

describe('TriageActionSchema', () => {
  test('accepts ask with single_choice', () => {
    const r = safeValidate(TriageActionSchema, {
      action: 'ask',
      question: {
        text: 'Bạn có đau ngực không?',
        type: 'single_choice',
        options: [
          { value: 'yes', label: 'Có' },
          { value: 'no', label: 'Không' },
        ],
      },
    });
    expect(r.ok).toBe(true);
  });

  test('accepts ask with open_text (no options)', () => {
    const r = safeValidate(TriageActionSchema, {
      action: 'ask',
      question: { text: 'Mô tả thêm?', type: 'open_text' },
    });
    expect(r.ok).toBe(true);
  });

  test('rejects single_choice with only one option', () => {
    const r = safeValidate(TriageActionSchema, {
      action: 'ask',
      question: {
        text: 'x?',
        type: 'single_choice',
        options: [{ value: 'a', label: 'A' }],
      },
    });
    expect(r.ok).toBe(false);
  });

  test('rejects unknown action', () => {
    const r = safeValidate(TriageActionSchema, { action: 'mystery' });
    expect(r.ok).toBe(false);
  });
});

describe('SymptomAnalysisSchema', () => {
  test('defaults are applied', () => {
    const r = safeValidate(SymptomAnalysisSchema, { detected_symptoms: ['fatigue'] });
    expect(r.ok).toBe(true);
    expect(r.data.needs_script).toBe(false);
  });
});
