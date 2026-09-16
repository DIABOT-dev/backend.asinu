const {
  doctorCopilotOutputSchema,
  normalizeCopilotOutput,
  validateGroundedCitations,
} = require('../src/services/integrations/doctor-copilot.schema');
const {
  evaluateClinicalRules,
  glucoseValueInUnit,
} = require('../src/services/integrations/doctor-rule-engine');
const {
  buildDataQuality,
  hashClinicalContext,
} = require('../src/services/integrations/doctor-context.service');
const { doctorAiAssistSchema } = require('../src/services/integrations/doctor-task.policy');
const { __test__ } = require('../src/services/integrations/doctor-ai.service');

const sourceId = '11111111-1111-4111-8111-111111111111';
const chunkId = '22222222-2222-4222-8222-222222222222';

const emptyRawOutput = () => ({
  patient_reply: '',
  clinical_summary: '',
  clinical_rationale: '',
  clarifying_questions: [],
  red_flags: [],
  urgency: 'routine',
  soap_note: { subjective: '', objective: '', assessment: '', plan: '' },
  abnormal_findings: [],
  missing_data: [],
  conflicts: [],
  follow_up_draft: '',
  citations: [],
  uncertainties: [],
  safety_alerts: [],
});

describe('Doctor clinical copilot schema and grounding', () => {
  test('normalizes provider output into a strict output contract', () => {
    const normalized = normalizeCopilotOutput({ summary: 'Tóm tắt', questions: ['Câu hỏi?'] });
    expect(doctorCopilotOutputSchema.safeParse(normalized).success).toBe(true);
    expect(normalized.clinical_summary).toBe('Tóm tắt');
    expect(normalized.clarifying_questions).toEqual(['Câu hỏi?']);
  });

  test('rejects citations to unknown chunks and non-verbatim quotes', () => {
    const chunks = [
      { source_id: sourceId, chunk_id: chunkId, content: 'Theo dõi huyết áp hằng ngày.' },
    ];
    expect(
      validateGroundedCitations(
        [{ source_id: sourceId, chunk_id: chunkId, quote: 'huyết áp hằng ngày' }],
        chunks
      )
    ).toEqual([]);
    expect(
      validateGroundedCitations(
        [{ source_id: sourceId, chunk_id: chunkId, quote: 'uống thuốc mới' }],
        chunks
      )
    ).toHaveLength(1);
    expect(
      validateGroundedCitations(
        [{ source_id: sourceId, chunk_id: '33333333-3333-4333-8333-333333333333', quote: 'x' }],
        chunks
      )
    ).toHaveLength(1);
    expect(
      doctorAiAssistSchema.safeParse({
        tenant_id: 'clinic-demo',
        task_id: 'task-1',
        app_user_id: '42',
        task_summary: 'Review blood pressure.',
        touchpoint: 'consultation_draft',
        clinical_support: {
          policy_version: 'a'.repeat(64),
          retrieval_mode: 'lexical',
          knowledge_chunks: [
            {
              source_id: sourceId,
              chunk_id: chunkId,
              title: 'Guideline',
              publisher: 'Publisher',
              version: '1',
              source_url: 'http://unsafe.example/guideline',
              specialty: 'general',
              locale: 'en',
              valid_until: null,
              content: 'Approved clinical guidance with enough content.',
              retrieval_score: 0.8,
            },
          ],
          rules: [],
        },
      }).success
    ).toBe(false);
  });

  test('strict schema blocks hidden model fields', () => {
    expect(
      doctorCopilotOutputSchema.safeParse({ ...emptyRawOutput(), chain_of_thought: 'hidden' })
        .success
    ).toBe(false);
  });
});

describe('approved clinical rule engine', () => {
  test('evaluates fresh blood pressure rules and ignores old observations', () => {
    const rule = {
      rule_id: sourceId,
      version: '1',
      source_document_id: chunkId,
      severity: 'urgent',
      rule_type: 'observation_threshold',
      patient_message: 'Liên hệ cơ sở y tế.',
      expert_message: 'Huyết áp vượt ngưỡng.',
      config: {
        metric: 'systolic',
        operator: 'gte',
        threshold: 180,
        unit: 'mmHg',
        maxAgeHours: 24,
      },
    };
    const now = new Date('2026-09-16T10:00:00.000Z');
    const findings = evaluateClinicalRules(
      [rule],
      {
        blood_pressure: [
          { systolic: 185, diastolic: 100, occurred_at: '2026-09-16T09:00:00.000Z' },
          { systolic: 200, diastolic: 110, occurred_at: '2026-09-10T09:00:00.000Z' },
        ],
      },
      now
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(185);
  });

  test('converts glucose units before applying the approved threshold', () => {
    expect(glucoseValueInUnit(180, 'mg/dL', 'mmol/L')).toBe(10);
    expect(glucoseValueInUnit(10, 'mmol/L', 'mg/dL')).toBe(180);
  });

  test('detects a symptom documented across the approved duration', () => {
    const findings = evaluateClinicalRules(
      [
        {
          rule_id: sourceId,
          version: '1',
          source_document_id: chunkId,
          severity: 'soon',
          rule_type: 'symptom_duration',
          patient_message: 'Theo dõi và liên hệ chuyên gia.',
          expert_message: 'Triệu chứng kéo dài.',
          config: { symptom: 'đau đầu', minimumDays: 3, maxAgeHours: 168 },
        },
      ],
      {
        symptoms: [
          { symptom_name: 'đau đầu', occurred_date: '2026-09-14' },
          { symptom_name: 'đau đầu', occurred_date: '2026-09-16' },
        ],
      },
      new Date('2026-09-16T10:00:00.000Z')
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe(3);
  });

  test('does not trigger on future observations', () => {
    const findings = evaluateClinicalRules(
      [
        {
          rule_id: sourceId,
          version: '1',
          source_document_id: chunkId,
          severity: 'emergency',
          rule_type: 'observation_threshold',
          patient_message: 'Liên hệ cơ sở y tế.',
          expert_message: 'Chỉ số vượt ngưỡng.',
          config: {
            metric: 'systolic',
            operator: 'gte',
            threshold: 180,
            unit: 'mmHg',
            maxAgeHours: 24,
          },
        },
      ],
      {
        blood_pressure: [
          { systolic: 200, diastolic: 100, occurred_at: '2026-09-16T11:00:00.000Z' },
        ],
      },
      new Date('2026-09-16T10:00:00.000Z')
    );
    expect(findings).toEqual([]);
  });
});

describe('context versioning and safety boundaries', () => {
  test('context hash is key-order independent and changes with clinical data', () => {
    expect(hashClinicalContext({ a: 1, b: { c: 2 } })).toBe(
      hashClinicalContext({ b: { c: 2 }, a: 1 })
    );
    expect(hashClinicalContext({ a: 1 })).not.toBe(hashClinicalContext({ a: 2 }));
  });

  test('data quality detects missing profile facts and conflicting medicine doses', () => {
    const result = buildDataQuality({
      profile: { birth_year: null, gender: null, allergies: [] },
      medications: [
        { med_name: 'Thuốc A', dose_text: '1 viên' },
        { med_name: 'Thuốc A', dose_text: '2 viên' },
      ],
      blood_pressure: [{ systolic: 80, diastolic: 90, occurred_at: '2026-09-16T09:00:00.000Z' }],
    });
    expect(result.missing_data.length).toBeGreaterThanOrEqual(3);
    expect(result.conflicts).toHaveLength(2);
  });

  test('patient safety filtering does not erase internal medication or measurement facts', () => {
    const raw = {
      ...emptyRawOutput(),
      patient_reply: 'Bạn bị tăng huyết áp và dùng metformin 500 mg.',
      clinical_summary: 'Hồ sơ ghi nhận metformin và glucose 100 mg/dL.',
    };
    const output = __test__.buildOutput({
      raw,
      input: {
        locale: 'vi',
        touchpoint: 'consultation_draft',
        clinical_support: { knowledge_chunks: [] },
      },
      context: {
        missing_data: [],
        conflicts: [],
        latest_patient_message: { message: 'Tôi nên làm gì?' },
      },
      ruleFindings: [],
    });
    expect(output.patient_reply).toContain('chuyên gia');
    expect(output.clinical_summary).toContain('metformin');
    expect(output.clinical_summary).toContain('100 mg/dL');
  });

  test('malformed provider JSON is rejected', () => {
    expect(() => __test__.parseModelJson('not-json')).toThrow('invalid JSON');
  });

  test('retries only provider output validation failures', () => {
    expect(__test__.isRetryableProviderOutputError({ code: 'DOCTOR_AI_INVALID_RESPONSE' })).toBe(true);
    expect(__test__.isRetryableProviderOutputError({ code: 'DOCTOR_AI_CITATION_INVALID' })).toBe(true);
    expect(__test__.isRetryableProviderOutputError({ code: 'DOCTOR_AI_PROVIDER_UNAVAILABLE' })).toBe(false);
    expect(__test__.isRetryableProviderOutputError({ code: 'AI_CONTEXT_STALE' })).toBe(false);
  });

  test('defaults clinical copilot to MedGemma and rejects unknown providers', () => {
    const previousDoctorProvider = process.env.DOCTOR_AI_PROVIDER;
    const previousClinicalProvider = process.env.AI_PROVIDER_CLINICAL;
    delete process.env.DOCTOR_AI_PROVIDER;
    delete process.env.AI_PROVIDER_CLINICAL;
    expect(__test__.resolveClinicalProvider()).toBe('medgemma');
    process.env.DOCTOR_AI_PROVIDER = 'unknown-provider';
    expect(() => __test__.resolveClinicalProvider()).toThrow('Unsupported clinical AI provider');
    if (previousDoctorProvider === undefined) delete process.env.DOCTOR_AI_PROVIDER;
    else process.env.DOCTOR_AI_PROVIDER = previousDoctorProvider;
    if (previousClinicalProvider === undefined) delete process.env.AI_PROVIDER_CLINICAL;
    else process.env.AI_PROVIDER_CLINICAL = previousClinicalProvider;
  });

  test('keeps patient-facing output empty when there is no current patient message', () => {
    const output = __test__.buildOutput({
      raw: {
        ...emptyRawOutput(),
        patient_reply: 'Tôi sẽ trả lời câu hỏi này.',
        clarifying_questions: ['Bạn có triệu chứng gì khác không?'],
        urgency: 'urgent',
      },
      input: {
        locale: 'vi',
        touchpoint: 'consultation_draft',
        clinical_support: { knowledge_chunks: [] },
      },
      context: { missing_data: [], conflicts: [], latest_patient_message: null },
      ruleFindings: [],
    });
    expect(output.patient_reply).toBe('');
    expect(output.clarifying_questions).toEqual([]);
    expect(output.urgency).toBe('routine');
    expect(output.uncertainties).toContain('Chưa có tin nhắn của bệnh nhân trong ca hiện tại.');
  });
});
