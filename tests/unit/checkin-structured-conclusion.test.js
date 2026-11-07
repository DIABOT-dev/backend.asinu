'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const logger = require('../../src/lib/logger');
const { generateConclusion } = require('../../src/core/checkin/triage-ai-layer');
const {
  buildConclusionFacts,
  validateBlock,
  composeConclusion,
  BLOCKS,
} = require('../../src/core/checkin/triage-conclusion');
const { getNextTriageQuestion } = require('../../src/services/checkin/checkin.triage.v2');
const { calculateConclusion } = require('../../src/core/checkin/triage-engine');
const { getNextStep } = require('../../src/core/checkin/triage-engine');
const { cases } = require('../../tools/checkin-conclusion-lab/cases.cjs');
const { t } = require('../../src/i18n');
const {
  buildNarrativeSystem,
  buildNarrativePrompt,
} = require('../../src/core/checkin/triage-conclusion-prompt');

const profile = { age: 52, gender: 'Nam', medical_conditions: ['Mỡ máu cao'] };
const state = () => ({
  allSymptoms: ['mệt mỏi', 'khó ngủ'],
  currentSymptoms: ['mệt mỏi', 'khó ngủ'],
  onset: 'vài ngày nay',
  progression: 'same',
  redFlagsFound: [],
  actionsFound: [],
  completedSteps: new Set(['red_flags']),
  severity: 'medium',
  needsDoctor: true,
  followUpHours: 3,
});
const candidate = () => ({
  loi_nhan: 'Chú mệt và khó ngủ vài ngày nay, tình trạng vẫn như cũ. Cháu hiểu chú đang uể oải ạ.',
  lien_quan:
    'Ngủ kém thường ảnh hưởng tới cảm giác mệt. Với mỡ máu cao đã khai, sinh hoạt đều đặn cũng cần được quan tâm.',
  nen_lam: ['Giữ giờ thức dậy đều đặn.', 'Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.'],
  di_kham_khi: [
    'Chú nên đến phòng khám trong vài ngày tới.',
    'Nếu khó chịu ảnh hưởng nhiều tới sinh hoạt, chú đi khám sớm hơn nhé.',
  ],
});
beforeEach(() => {
  jest.clearAllMocks();
  callTextAi.mockResolvedValue({
    content: JSON.stringify(candidate()),
    model: 'medgemma-27b-it',
    usage: { total: 700 },
  });
});

test('narrative does not fall back when unrelated paragraphs mention current relief and earlier activities', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú đang đau đầu từ hôm qua. Cháu hiểu chú đang khó chịu.\n\nChú đã đỡ đau khi nghỉ ngơi.\n\nChú nên ghi lại các hoạt động trước đó.\n\n- Chú nên đi khám trong vài ngày tới.',
  });
  const result = await generateConclusion(
    {
      ...state(),
      allSymptoms: ['đau đầu'],
      currentSymptoms: ['đau đầu'],
      actionsFound: ['nghỉ ngơi'],
    },
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).toContain('đã đỡ đau khi nghỉ ngơi');
  expect(result.narrative).toContain('các hoạt động trước đó');
});

test('a detailed conclusion keeps the explanation but removes a model request to answer the assessment again', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú kể đau đầu từ hôm qua và vẫn như cũ. Cháu hiểu chú đang khó chịu.\n\nChú có thể cho cháu biết mức độ đau của chú thế nào không?\n\n- Chú nên đi khám trong vài ngày tới.',
  });
  const input = {
    ...state(),
    allSymptoms: ['đau đầu'],
    currentSymptoms: ['đau đầu'],
    regionDetails: [
      {
        region: 'head',
        label: 'Đầu',
        symptoms: ['đau đầu'],
        answers: { severity: 'Vừa', onset: 'từ hôm qua' },
      },
    ],
    detailedAssessmentComplete: true,
    detailedAssessmentVersion: 2,
  };
  const result = await generateConclusion(
    input,
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.narrative).toContain('Cháu hiểu chú đang khó chịu.');
  expect(result.narrative).not.toContain('cho cháu biết');
  expect(result.conclusionPromptVersion).toBe('v3-narrative-deep-details');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'narrative',
    reason: 'repeated_assessment_question',
    scope: 'sentence',
  });
});

test('head and limbs keep separate symptom groups and their exact positions reach the conclusion facts', async () => {
  const notes = 'Đầu: Trán; Tay chân: Cổ tay phải';
  const input = {
    status: 'tired',
    phase: 'initial',
    profile,
    bodyLocations: ['head', 'limbs'],
    bodyLocationOther: notes,
  };
  const question = await getNextTriageQuestion({ ...input, previousAnswers: [] });
  expect(question.optionsGrouped.map((group) => group.key)).toEqual(['head', 'limbs']);
  expect(question.question.toLowerCase()).toContain('đầu và tay chân');
  expect(callTextAi).not.toHaveBeenCalled();
  const previousAnswers = [
    { step: 'symptoms', answer: ['đau đầu', 'đau khớp'] },
    { step: 'onset', answer: 'hôm qua' },
    { step: 'progression', answer: 'vẫn như cũ' },
    { step: 'red_flags', answer: 'Không có' },
  ];
  const precise = getNextStep({ ...input, previousAnswers }).state;
  const old = getNextStep({
    ...input,
    bodyLocations: null,
    bodyLocationOther: null,
    previousAnswers,
  }).state;
  expect(calculateConclusion(precise, 'tired')).toEqual(calculateConclusion(old, 'tired'));
  const facts = buildConclusionFacts(precise, profile);
  expect(facts.vung_kho_chiu).toEqual(['head', 'limbs']);
  expect(facts.vi_tri_kho_chiu).toBe(notes);
  const prompt = buildNarrativePrompt(facts);
  expect(prompt).toContain(notes);
  expect(prompt).toContain('Chọn vùng không có nghĩa là đã báo đau');
});

test('a long position description remains in facts without making the next question exceed the API question limit', async () => {
  const notes = 'Đầu: Trán; Tay chân: Cổ tay phải; ' + 'Mô tả thêm vị trí. '.repeat(70);
  const input = {
    status: 'tired',
    phase: 'initial',
    profile,
    bodyLocations: ['head', 'limbs'],
    bodyLocationOther: notes,
    previousAnswers: [],
  };
  const question = await getNextTriageQuestion(input);
  expect(question.question.length).toBeLessThanOrEqual(500);
  const facts = buildConclusionFacts(getNextStep(input).state, profile);
  expect(facts.vi_tri_kho_chiu).toBe(notes.trim());
});

test('free narrative prompt asks for everyday paragraphs and bullets without the four-field template', () => {
  const facts = buildConclusionFacts(state(), profile);
  const system = buildNarrativeSystem(facts);
  const prompt = buildNarrativePrompt(facts);
  expect(system).toContain('lời đời thường');
  expect(prompt).toContain('gạch đầu dòng');
  expect(prompt).not.toMatch(/loi_nhan|lien_quan|nen_lam|di_kham_khi|Return 4 fields/);
  expect(prompt).not.toContain('Ghi 2 mốc giờ');
  expect(system).toContain('giải thích sâu');
  expect(prompt).toContain('vì sao mỗi việc có ích');
});

test.each(['vi', 'en'])(
  'new %s callers receive an unconstrained narrative and unchanged clinical decision',
  async (lang) => {
    const prose =
      lang === 'en'
        ? 'You have been having trouble sleeping for a few days. I understand this is tiring.\n\nA regular sleep routine can help you notice what changes.\n\n- Keep your bedtime regular.\n- Please arrange an assessment over the next few days.\n- If discomfort worsens, seek an assessment.'
        : 'Mấy ngày nay chú khó ngủ, cháu hiểu chú đang khá mệt.\n\nGiấc ngủ và nếp sinh hoạt thường ảnh hưởng đến cảm giác mệt trong ngày.\n\n- Chú thử giữ giờ đi ngủ đều đặn nhé.\n- Chú nên đi khám trong vài ngày tới.\n- Nếu khó chịu tăng lên, chú hãy đi khám.';
    callTextAi.mockResolvedValue({ content: prose, model: 'medgemma-27b-it' });
    const input = state();
    const before = JSON.stringify(input);
    const result = await generateConclusion(
      input,
      profile,
      lang,
      null,
      {},
      { conclusionFormat: 'narrative' }
    );
    expect(result).toMatchObject({
      conclusionFormat: 'narrative',
      conclusionPromptVersion: 'v3-narrative-deep',
      conclusionSource: 'ai',
      followUpHours: 3,
    });
    expect(result.narrative).toContain(prose.split('\n')[0]);
    expect(result.narrative).toContain('- ');
    expect(result.narrative).not.toContain('Ghi 2 mốc giờ');
    expect(result.speechText.length).toBeLessThanOrEqual(1600);
    expect(result.speechText.endsWith(result.aiNotice)).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.recommendation).toBeTruthy();
    expect(result.disclaimer).toBe(t('checkin.conclusion.disclaimer', lang));
    expect(JSON.stringify(input)).toBe(before);
    expect(callTextAi.mock.calls[0][0].system).not.toContain('Return only JSON');
    expect(callTextAi.mock.calls[0][0]).toMatchObject({ maxTokens: 8192, timeoutMs: 60000 });
  }
);

test('narrative checks remove invented disease and broad emergency advice without losing the useful prose', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú đang khó ngủ và thấy mệt. Cháu hiểu cảm giác này không dễ chịu.\n\nChú bị suy giáp.\n\n- Nếu khó thở hoặc bất kỳ dấu hiệu bất thường nào khác, hãy gọi 115.\n- Chú nên đi khám trong vài ngày tới.',
  });
  const result = await generateConclusion(
    state(),
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).toContain('Cháu hiểu cảm giác này không dễ chịu.');
  expect(result.narrative).not.toMatch(/suy giáp|bất kỳ/);
  expect(result.followUpHours).toBe(3);
});

test('narrative provider failure still produces readable paragraphs, a notice and a single follow-up', async () => {
  callTextAi.mockRejectedValue(new Error('synthetic timeout'));
  const result = await generateConclusion(
    state(),
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionFormat).toBe('narrative');
  expect(result.conclusionSource).toBe('fallback');
  expect(result.narrative).toContain('\n\n');
  expect(result.narrative).toContain('- ');
  expect(result.narrative).not.toContain(result.closeMessage);
  expect(result.speechText.endsWith(result.aiNotice)).toBe(true);
});

test('a conditional warning list keeps its assessment action without turning self-monitoring into an immediate referral', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú đang khó ngủ, cháu hiểu chú đang mệt nhé.\n\n- Giữ giờ đi ngủ đều đặn.\n\nNếu khó ngủ kéo dài hoặc kèm theo:\n- Mệt nhiều ban ngày.\n- Khó tập trung.\n\nChú nên đi khám để được chuyên gia hỗ trợ.',
  });
  const result = await generateConclusion(
    { ...state(), severity: 'low', needsDoctor: false, followUpHours: 6 },
    { ...profile, medical_conditions: [] },
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).toContain(
    'Nếu khó ngủ kéo dài hoặc kèm theo Mệt nhiều ban ngày, Khó tập trung, chú nên đi khám'
  );
  expect(result.followUpHours).toBe(6);
  expect(result.narrative).not.toContain('đi khám hôm nay');
});

test('generic readings cannot be called stable without comparison data', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú đang mệt và khó ngủ, cháu hiểu chú đang khó chịu nhé.\n\nCác chỉ số này hiện tại đang ở mức ổn định.\n\n- Chú nên đi khám trong vài ngày tới.',
  });
  const result = await generateConclusion(
    state(),
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).not.toContain('ổn định');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'narrative',
    reason: 'insufficient_comparison_data',
    scope: 'sentence',
  });
});

test('a narrative measurement stays where the model discussed it, using the exact stored reading and time', async () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  const context = { recentBP: [{ systolic: 122, diastolic: 78, occurred_at: at }] };
  callTextAi.mockResolvedValue({
    content:
      'Chú đang mệt và khó ngủ, cháu hiểu chú đang khó chịu nhé.\n\n- Về chỉ số sức khỏe:\n  - Huyết áp của chú là 190/120 mmHg, khá tốt.\n\nChú nên đi khám trong vài ngày tới.\n\nCháu mong chú sớm dễ chịu.',
  });
  const result = await generateConclusion(state(), profile, 'vi', null, context, {
    conclusionFormat: 'narrative',
  });
  const record = buildConclusionFacts(state(), profile, context).chi_so_24h[0];
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).not.toMatch(/190\/120|khá tốt/);
  expect(result.narrative).toContain(record.luc);
  expect(result.narrative.indexOf('122/78 mmHg')).toBeLessThan(
    result.narrative.indexOf('Cháu mong chú sớm dễ chịu')
  );
});

test('a detailed narrative is not replaced merely for exceeding the old 8000-character display cap', async () => {
  const prose =
    'Chú đang khó ngủ và thấy mệt, cháu hiểu chú đang khó chịu.\n\n' +
    'Nếp sinh hoạt đều đặn giúp mình theo dõi những thay đổi trong ngày.\n\n'.repeat(135) +
    '- Chú nên đi khám trong vài ngày tới.';
  expect(prose.length).toBeGreaterThan(8000);
  callTextAi.mockResolvedValue({ content: prose, model: 'medgemma-27b-it', finishReason: 'stop' });
  const result = await generateConclusion(
    state(),
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative.length).toBeGreaterThan(8000);
  expect(result.narrative).toContain('Chú nên đi khám trong vài ngày tới.');
  expect(result.speechText.length).toBeLessThanOrEqual(1600);
});

test('a deep narrative keeps model-chosen headings and removes unsupported assurances about disease control', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chú đang khó ngủ và thấy mệt, cháu hiểu chú đang khó chịu.\n\n### Những điều cần chú ý\n\nHuyết áp của chú đang ở mức khá tốt. Đây là một tín hiệu tốt, cho thấy các bệnh nền của chú đang được kiểm soát khá tốt.\n\n### Việc có thể làm hôm nay\n\n- Giữ giờ ngủ đều đặn.\n- Chú nên đi khám trong vài ngày tới.',
  });
  const result = await generateConclusion(
    state(),
    profile,
    'vi',
    null,
    {},
    { conclusionFormat: 'narrative' }
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).toContain('### Những điều cần chú ý');
  expect(result.narrative).toContain('### Việc có thể làm hôm nay');
  expect(result.narrative).not.toContain('kiểm soát khá tốt');
  expect(result.narrative).not.toContain('Huyết áp của chú đang');
});

test('returns four AI blocks, fixed disclaimer, one server follow-up and legacy fields', async () => {
  const result = await generateConclusion(state(), profile);
  expect(result).toMatchObject({
    conclusionVersion: 2,
    conclusionPromptVersion: 'v3',
    conclusionRenderVersion: 2,
    conclusionSource: 'ai',
    todo: candidate().nen_lam,
    seeDoctorWhen: candidate().di_kham_khi,
    followUpHours: 3,
  });
  expect(result.summary).toBe(`${candidate().loi_nhan} ${candidate().lien_quan}`);
  expect(result.recommendation).toBe(
    [...candidate().nen_lam, ...candidate().di_kham_khi].join('\n')
  );
  expect(result.disclaimer).toBe(
    require('../../src/i18n/locales/vi.json')['checkin.conclusion.disclaimer']
  );
  expect(result.disclaimer).toContain('điều trị của bác sĩ.');
  expect(result.disclaimer).toContain('chẩn đoán');
  expect(result.closeMessage).toContain('3 giờ');
  expect(result.speechText).toBe(
    [candidate().loi_nhan, ...candidate().di_kham_khi, result.closeMessage, result.aiNotice].join(
      ' '
    )
  );
  expect(result.speechText).not.toContain(result.explanation);
  expect(result.aiNotice).toBe(
    require('../../src/i18n/locales/vi.json')['checkin.conclusion.ai_notice']
  );
  expect(result.speechText.endsWith(result.aiNotice)).toBe(true);
  expect(logger.warn).not.toHaveBeenCalled();
  expect(callTextAi).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'medgemma',
      strictProvider: true,
      model: 'medgemma-27b-it',
      maxTokens: 700,
      timeoutMs: 10000,
      maxRetries: 0,
    })
  );
});

test('V3 live-response regression: natural prose and four activities reach the API without fallback', async () => {
  const raw = {
    loi_nhan:
      'Chào chú, cháu thấy chú đang gặp khó khăn với giấc ngủ từ hôm qua đến giờ. Chắc chú đang cảm thấy khá mệt mỏi vì không được nghỉ ngơi đầy đủ phải không ạ?',
    lien_quan:
      'Khó ngủ có thể do nhiều nguyên nhân khác nhau, chú ạ. Đôi khi chỉ là do thay đổi thói quen sinh hoạt, hoặc cũng có thể là dấu hiệu cơ thể đang cần được quan tâm hơn một chút.',
    nen_lam: [
      'Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.',
      'Thử tạo một không gian ngủ thật yên tĩnh, thoải mái.',
      'Tránh dùng các chất kích thích như cà phê, trà đặc vào buổi tối.',
      'Thư giãn nhẹ nhàng trước khi ngủ, ví dụ như đọc sách hoặc nghe nhạc êm dịu.',
    ],
    di_kham_khi: [
      'Nếu tình trạng khó ngủ kéo dài nhiều ngày và ảnh hưởng đến sinh hoạt hàng ngày của chú, chú nên đi khám để được chuyên gia tư vấn.',
      'Nếu chú cảm thấy rất mệt mỏi, chóng mặt, hoặc có bất kỳ dấu hiệu bất thường nào khác kèm theo, chú hãy đi khám ngay để được kiểm tra kịp thời.',
    ],
  };
  callTextAi.mockResolvedValue({ content: JSON.stringify(raw) });
  const input = {
    ...state(),
    allSymptoms: ['khó ngủ'],
    onset: 'hôm qua',
    severity: 'low',
    needsDoctor: false,
    followUpHours: 6,
  };
  const result = await generateConclusion(input, { ...profile, medical_conditions: [] });
  expect(result).toMatchObject({
    personalMessage: raw.loi_nhan,
    explanation: raw.lien_quan,
    todo: raw.nen_lam,
    seeDoctorWhen: raw.di_kham_khi,
    conclusionSource: 'ai',
    followUpHours: 6,
  });
  expect(logger.warn).not.toHaveBeenCalled();
  expect(input.needsDoctor).toBe(false);
});

test('V3 server repairs missing reminders and a referral location without replacing valid AI prose', async () => {
  const explanation =
    'Ngủ kém thường ảnh hưởng tới cảm giác mệt. Chú nên gặp chuyên gia để được thăm khám kỹ hơn.';
  const actions = [
    'Chú thử ghi lại 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.',
    'Giữ giờ thức dậy đều đặn.',
  ];
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      lien_quan: explanation,
      nen_lam: actions,
      di_kham_khi: ['Nếu mệt nhiều hơn, chú hãy đi khám.', 'Nếu khó thở, hãy gọi 115.'],
    }),
  });
  const result = await generateConclusion(state(), {
    ...profile,
    medical_conditions: ['Cao huyết áp'],
  });
  expect(result.explanation).toContain('Ngủ kém thường ảnh hưởng tới cảm giác mệt.');
  expect(result.explanation).not.toContain('thăm khám');
  expect(result.todo).toEqual([...actions, 'Đo lại huyết áp và ghi giờ đo.']);
  expect(result.seeDoctorWhen).toEqual([
    'Chú nên đi khám trong vài ngày tới.',
    'Nếu mệt nhiều hơn, chú hãy đi khám.',
    'Nếu khó thở, hãy gọi 115.',
    'Chú nên gặp chuyên gia để được thăm khám kỹ hơn.',
  ]);
  expect(result.conclusionSource).toBe('ai');
  expect(logger.warn).not.toHaveBeenCalled();
});

test.each([
  ['dấu hiệu cơ thể đang cần dùng aspirin', 'drug_name_or_class'],
  ['dấu hiệu cơ thể đang cần 5 mg', 'drug_dose'],
  ['dấu hiệu cơ thể đang cần được kiểm tra vì trầm cảm', 'undeclared_disease'],
  ['mắc trầm cảm', 'speculative_diagnosis'],
])('V3 neutral-possibility repair never hides unsafe content: %s', async (ending, reason) => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ ...candidate(), lien_quan: `Khó ngủ có thể là ${ending}.` }),
  });
  const result = await generateConclusion(state(), profile);
  expect(result.conclusionSource).toBe('partial_fallback');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', { block: 'lien_quan', reason });
});

test('V3 reminder repair cannot mask a care-level contradiction', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      di_kham_khi: ['Chú nên đi khám hôm nay.', 'Nếu mệt nhiều hơn, chú hãy đi khám.'],
    }),
  });
  const result = await generateConclusion(
    { ...state(), severity: 'low', needsDoctor: false },
    profile
  );
  expect(result.seeDoctorWhen.join(' ')).not.toContain('đi khám hôm nay');
  expect(result.conclusionSource).toBe('partial_fallback');
  expect(logger.warn).toHaveBeenCalledWith(
    'conclusion_rejected',
    expect.objectContaining({ block: 'di_kham_khi' })
  );
});

test('V3 screenshot regression: preserve useful explanation instead of replacing it with the generic conditions fallback', async () => {
  const useful =
    'Với bệnh nền đã khai, cảm giác lo âu và buồn bã cũng cần được quan tâm cùng sức khỏe thể chất.';
  const supportive = 'Giữ nếp sinh hoạt đều đặn giúp mình theo dõi những thay đổi trong ngày.';
  const raw = {
    ...candidate(),
    loi_nhan:
      'Bạn đang thấy lo âu và buồn bã vài giờ nay. Mình hiểu cảm giác này không dễ chịu. Bạn từng nhắc đau chân trong các lần check-in trước, nhưng triệu chứng này có vẻ đã ổn định rồi.',
    lien_quan: `${useful} Việc có một ngày bỏ thuốc là điều mình lo lắng. ${supportive}`,
    nen_lam: [
      'Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.',
      'Đo lại huyết áp và đường huyết và ghi giờ đo.',
      'Dành thời gian nghỉ ngơi và thư giãn nhé.',
      'Uống thuốc đúng như bác sĩ đã kê.',
    ],
    di_kham_khi: [
      'Bạn nên đi khám trong vài ngày tới.',
      'Nếu lo âu kéo dài, bạn hãy gặp chuyên gia.',
      'Nếu đau ngực, khó thở hoặc có bất kỳ dấu hiệu bất thường nào khác, hãy gọi 115 ngay.',
    ],
  };
  callTextAi.mockResolvedValue({ content: JSON.stringify(raw) });
  const input = { ...state(), allSymptoms: ['lo âu', 'buồn bã'], onset: 'vài giờ nay' };
  const snapshot = (value) =>
    JSON.stringify(value, (_key, item) => (item instanceof Set ? [...item] : item));
  const before = snapshot(input);
  const result = await generateConclusion(
    input,
    { age: 57, medical_conditions: ['Tiểu đường', 'Cao huyết áp', 'Tim mạch'] },
    'vi',
    null,
    { tookMedicationToday: true }
  );
  expect(result.explanation).toContain(useful);
  expect(result.explanation).toContain(supportive);
  expect(result.explanation).not.toMatch(/bỏ thuốc|Mình cần xem thông tin này/);
  expect(result.personalMessage).toContain('Bạn từng nhắc đau chân trong các lần check-in trước.');
  expect(result.personalMessage).not.toContain('ổn định');
  expect(result.todo).toEqual(raw.nen_lam.slice(0, 3));
  expect(result.seeDoctorWhen).toEqual(raw.di_kham_khi.slice(0, 2));
  expect(result.conclusionSource).toBe('ai');
  expect(snapshot(input)).toBe(before);
  for (const [block, reason, scope] of [
    ['loi_nhan', 'unconfirmed_prior_symptom_resolution', 'sentence'],
    ['lien_quan', 'treatment_change', 'sentence'],
    ['nen_lam', 'nonmedication_actions_only', 'item'],
    ['di_kham_khi', 'nonspecific_emergency_condition', 'item'],
  ])
    expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', { block, reason, scope });
});

test('V3 preserves accurate readings when an unrelated sentence in the explanation is rejected', async () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  const facts = buildConclusionFacts(state(), profile, {
    recentBP: [{ systolic: 122, diastolic: 78, occurred_at: at }],
  });
  const reading = facts.chi_so_24h[0];
  const sentence = `Huyết áp ${reading.gia_tri} ${reading.don_vi} lúc ${reading.luc}.`;
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      lien_quan: `Ngủ kém thường ảnh hưởng tới cảm giác mệt. ${sentence} Chú nên ngừng thuốc.`,
    }),
  });
  const result = await generateConclusion(state(), profile, 'vi', null, {
    recentBP: [{ systolic: 122, diastolic: 78, occurred_at: at }],
  });
  expect(result.explanation).toContain('Ngủ kém thường ảnh hưởng tới cảm giác mệt.');
  expect(result.explanation).toContain(sentence);
  expect(result.explanation).not.toContain('ngừng thuốc');
  expect(result.conclusionSource).toBe('ai');
  expect(result.followUpHours).toBe(3);
});

test('V3 never manufactures a useful explanation when every sentence is rejected', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      lien_quan: 'Chú nên ngừng thuốc. Chú nên tăng liều.',
    }),
  });
  const result = await generateConclusion(state(), profile);
  expect(result.conclusionSource).toBe('partial_fallback');
  expect(result.explanation).not.toMatch(/ngừng thuốc|tăng liều/);
  expect(result.personalMessage).toBe(candidate().loi_nhan);
});

test('V3 drops an inaccurate measurement sentence and completes exact facts without losing the explanation', async () => {
  const at = new Date(Date.now() - 3600000).toISOString();
  const useful = 'Cảm giác lo âu và buồn bã cũng cần được quan tâm cùng sức khỏe thể chất.';
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      lien_quan: `${useful} Huyết áp là 190/120 mmHg vào hôm qua.`,
    }),
  });
  const context = { recentBP: [{ systolic: 122, diastolic: 78, occurred_at: at }] };
  const result = await generateConclusion(state(), profile, 'vi', null, context);
  const actual = buildConclusionFacts(state(), profile, context).chi_so_24h[0];
  expect(result.explanation).toContain(useful);
  expect(result.explanation).toContain('122/78 mmHg');
  expect(result.explanation).toContain(actual.luc);
  expect(result.explanation).not.toContain('190/120');
  expect(result.conclusionSource).toBe('ai');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'lien_quan',
    reason: 'ungrounded_measurement',
    scope: 'sentence',
  });
});
test('rejects only an unsafe block and logs reason without clinical text', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({ ...candidate(), lien_quan: 'Chú có thể là mắc trầm cảm.' }),
  });
  const result = await generateConclusion(state(), profile);
  expect(result.personalMessage).toBe(candidate().loi_nhan);
  expect(result.todo).toEqual(candidate().nen_lam);
  expect(result.explanation).not.toContain('trầm cảm');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'lien_quan',
    reason: 'speculative_diagnosis',
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Chú');
});
test.each(['invalid JSON', '{"loi_nhan":""}', 'null', '[]'])(
  'malformed output %s retains six readable blocks',
  async (content) => {
    callTextAi.mockResolvedValue({ content });
    const result = await generateConclusion(state(), profile);
    expect(result.personalMessage).toBeTruthy();
    expect(result.explanation).toBeTruthy();
    expect(result.todo.length).toBeGreaterThanOrEqual(2);
    expect(result.seeDoctorWhen.length).toBeGreaterThanOrEqual(2);
    expect(result.disclaimer).toBeTruthy();
    expect(result.closeMessage).toContain('3 giờ');
    expect(result.recommendation).not.toContain('cấp cứu');
  }
);
test('provider timeout retains the symptom-specific sleep guidance', async () => {
  callTextAi.mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }));
  const result = await generateConclusion(state(), profile);
  expect(result.todo.join(' ')).toMatch(/ngủ|giấc ngủ/);
  expect(result.seeDoctorWhen.join(' ')).not.toContain('115');
  expect(logger.warn).toHaveBeenCalledWith('conclusion_rejected', {
    block: 'response',
    reason: 'provider_unavailable',
  });
});
test('emergency templates bypass the AI and omit disclaimer/structured blocks', async () => {
  const result = await generateConclusion(
    { ...state(), emergencyType: 'stroke', severity: 'emergency' },
    profile
  );
  expect(callTextAi).not.toHaveBeenCalled();
  expect(result.isEmergency).toBe(true);
  expect(result.disclaimer).toBeUndefined();
  expect(result.conclusionVersion).toBeUndefined();
  expect(result.recommendation).toContain('115');
});
test('health context contains only bounded patient facts and preserves unknown medication', () => {
  const now = new Date('2026-10-29T08:00:00Z');
  const facts = buildConclusionFacts(
    state(),
    { ...profile, full_name: 'Private Name', email: 'private@example.com', phone: '000' },
    {
      recentBP: [
        { systolic: 128, diastolic: 82, occurred_at: '2026-10-29T06:00:00Z' },
        { systolic: 130, diastolic: 84, occurred_at: '2026-10-27T06:00:00Z' },
        { systolic: 140, diastolic: 90, occurred_at: '2026-10-30T06:00:00Z' },
      ],
      recentGlucose: [{ value: '6.4', unit: 'mmol/L', occurred_at: '2026-10-29T05:00:00Z' }],
      tookMedicationToday: false,
      previousCheckins: [
        { session_date: '2026-10-27', initial_status: 'tired', triage_summary: 'khó ngủ' },
      ],
      symptomFrequencyContext: 'Khó ngủ: 2 lần',
      medicationAdherenceContext: null,
    },
    'vi',
    now
  );
  expect(facts.chi_so_24h).toHaveLength(2);
  expect(facts.chi_so_7_ngay).toHaveLength(1);
  expect(facts.chi_so_24h[0].luc).toContain('13:00');
  expect(facts.uong_thuoc_hom_nay).toBe('chưa ghi');
  expect(facts.check_in_truoc[0].tom_tat).toBe('khó ngủ');
  expect(facts.trieu_chung_lap_lai).toBe('Khó ngủ: 2 lần');
  expect(JSON.stringify(facts)).not.toMatch(/Private Name|private@example/);
});
test('no 24h value means no old numbers; comparison requires same-type pairs', () => {
  const facts = buildConclusionFacts(state(), profile);
  facts.chi_so_7_ngay = [
    { loai: 'huyet_ap', gia_tri: '128/82', don_vi: 'mmHg', luc: '13:00 27/10/26' },
  ];
  expect(validateBlock('lien_quan', 'Huyết áp hôm trước là 128/82 mmHg.', facts)).toBe(
    'ungrounded_measurement'
  );
  facts.chi_so_24h = [
    { loai: 'huyet_ap', gia_tri: '130/84', don_vi: 'mmHg', luc: '13:00 29/10/26' },
  ];
  expect(
    validateBlock(
      'lien_quan',
      'Huyết áp 130/84 mmHg lúc 13:00 29/10/26, so với lần trước 128/82 mmHg lúc 13:00 27/10/26.',
      facts
    )
  ).toBeNull();
  expect(validateBlock('lien_quan', 'Đường huyết 130 mmol/L.', facts)).toBe(
    'ungrounded_measurement'
  );
});

test('block 2 always includes latest real 24h readings and declared conditions omitted by AI', async () => {
  callTextAi.mockResolvedValue({
    content: JSON.stringify({
      ...candidate(),
      lien_quan: 'Sinh hoạt đều đặn giúp theo dõi sức khỏe.',
    }),
  });
  const result = await generateConclusion(state(), profile, 'vi', null, {
    recentBP: [
      { systolic: 128, diastolic: 82, occurred_at: new Date(Date.now() - 3600000).toISOString() },
    ],
  });
  expect(result.explanation).toContain('Mỡ máu cao');
  expect(result.explanation).toContain('128/82 mmHg');
  expect(result.explanation).toMatch(/\d{2}:\d{2}/);
  expect(result.todo).toEqual(candidate().nen_lam);
});

test('server factual completion never promotes a historical measurement to a current reading', async () => {
  const result = await generateConclusion(state(), profile, 'vi', null, {
    recentBP: [
      {
        systolic: 128,
        diastolic: 82,
        occurred_at: new Date(Date.now() - 48 * 3600000).toISOString(),
      },
    ],
  });
  expect(result.explanation).not.toContain('128/82');
});
test('V3 allows explanations and declared conditions, keeps activities non-medication, and forbids changing treatment', () => {
  const facts = buildConclusionFacts(state(), profile, { tookMedicationToday: true });
  expect(
    validateBlock('lien_quan', 'Vì chú khó ngủ nên cháu hiểu chú đang mệt.', facts)
  ).toBeNull();
  expect(
    validateBlock('nen_lam', ['Uống thuốc đúng như bác sĩ đã kê.', 'Ghi giờ đi ngủ.'], facts)
  ).toBe('nonmedication_actions_only');
  expect(validateBlock('nen_lam', ['Giảm liều thuốc.', 'Ghi giờ đi ngủ.'], facts)).toBe(
    'treatment_change'
  );
  expect(validateBlock('lien_quan', 'Chú đã khai mắc mỡ máu cao.', facts)).toBeNull();
  expect(validateBlock('lien_quan', 'Chú bị suy giáp.', facts)).toBe('undeclared_disease');
});

test('a permitted adherence reminder cannot hide an unrelated medication instruction', () => {
  const facts = buildConclusionFacts(state(), profile, { tookMedicationToday: true });
  expect(
    validateBlock('nen_lam', ['Chú dùng thuốc bổ.', 'Uống thuốc đúng như bác sĩ đã kê.'], facts)
  ).toBe('medication_instruction');
});

test.each([
  'Mỡ máu của chú vẫn cao.',
  'Mỡ máu của chú cao.',
  'Mỡ máu hiện tại cao.',
  'Mỡ máu của chú ổn định.',
])('declared high cholesterol is not a new measured result: %s', (claim) => {
  expect(validateBlock('lien_quan', claim, buildConclusionFacts(state(), profile))).toBe(
    'unmeasured_lipid_claim'
  );
});
test('does not accept changing required assessment into conditional-only advice', () => {
  const facts = buildConclusionFacts(state(), profile);
  expect(
    validateBlock(
      'di_kham_khi',
      ['Nếu khó ngủ nhiều hơn thì đi khám.', 'Nếu khó thở thì gọi 115.'],
      facts
    )
  ).toBe('required_referral_missing');
  expect(validateBlock('di_kham_khi', candidate().di_kham_khi, facts)).toBeNull();
});
test('self-monitoring cannot become an immediate assessment instruction', () => {
  const facts = buildConclusionFacts({ ...state(), needsDoctor: false }, profile);
  expect(
    validateBlock('di_kham_khi', ['Chú nên đi khám hôm nay.', 'Nếu đau ngực thì gọi 115.'], facts)
  ).toBe('upgraded_care_level');
});

test('word boundaries do not confuse lưng thường or khó ngủ with cancer or cough', async () => {
  const facts = buildConclusionFacts(state(), profile);
  expect(
    validateBlock('lien_quan', 'Đau lưng thường liên quan đến tư thế sinh hoạt.', facts)
  ).toBeNull();
  callTextAi.mockRejectedValueOnce(new Error('offline'));
  const result = await generateConclusion(state(), profile);
  expect(result.todo.join(' ')).toMatch(/ngủ/);
  expect(result.todo.join(' ')).not.toMatch(/nhiệt độ|khói thuốc/);
});

test('measurement grounding accepts an optional ngày separator but rejects wrong date or time', () => {
  const facts = buildConclusionFacts(state(), profile);
  facts.chi_so_24h = [
    { loai: 'huyet_ap', gia_tri: '128/82', don_vi: 'mmHg', luc: '13:00 29/10/26' },
  ];
  expect(
    validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 13:00 ngày 29/10/2026.', facts)
  ).toBeNull();
  expect(validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 14:00 ngày 29/10/2026.', facts)).toBe(
    'measurement_time_not_exact'
  );
  expect(validateBlock('lien_quan', 'Huyết áp 128/82 mmHg lúc 13:00 ngày 28/10/2026.', facts)).toBe(
    'measurement_time_not_exact'
  );
});
test('incomplete assessment is acknowledged while no absence of red flags is invented', async () => {
  const result = await generateConclusion({ ...state(), assessmentIncomplete: true }, profile);
  expect(result.personalMessage).toMatch(/chưa hỏi|chưa đủ/);
  const facts = buildConclusionFacts({ ...state(), assessmentIncomplete: true }, profile);
  expect(validateBlock('loi_nhan', 'Không có dấu hiệu nguy hiểm.', facts)).toBe(
    'unconfirmed_absence_of_red_flags'
  );
});
test('English fallback, disclaimer and schedule use the selected language', async () => {
  callTextAi.mockRejectedValue(new Error('offline'));
  const result = await generateConclusion(state(), profile, 'en');
  expect(result.disclaimer).toContain('Connect with an Asinu health expert');
  expect(result.closeMessage).toContain('3 hours');
  expect(result.todo.join(' ')).toMatch(/sleep|bedtime/);
});
test('integration passes context and keeps all new fields in the public result', async () => {
  // Empty symptom avoids the unrelated safety-classifier request in this test.
  const result = await getNextTriageQuestion({
    status: 'tired',
    forceConclusion: true,
    profile,
    healthContext: { tookMedicationToday: true, symptomFrequencyContext: 'Test frequency' },
    previousAnswers: [],
  });
  expect(result).toMatchObject({ isDone: true, conclusionVersion: 2 });
  expect(result.disclaimer).toBeTruthy();
  expect(result.todo).toHaveLength(2);
  const sent = callTextAi.mock.calls[0][0].prompt;
  expect(sent).toContain('Test frequency');
  expect(sent).toContain('đã có bản ghi uống thuốc');
});
test.each(cases().map((item) => [item.id, item]))(
  '30-case rule contract stays unchanged: %s',
  (_id, item) => {
    const expected = calculateConclusion(item.state, 'tired');
    const before = JSON.stringify({
      severity: item.state.severity,
      needsDoctor: item.state.needsDoctor,
      needsFamilyAlert: item.state.needsFamilyAlert,
      followUpHours: item.state.followUpHours,
    });
    const facts = buildConclusionFacts(item.state, item.profile, item.context, item.lang);
    const result = composeConclusion(candidate(), item.state, item.profile, item.lang);
    expect(result.followUpHours).toBe(expected.followUpHours);
    expect(
      JSON.stringify({
        severity: item.state.severity,
        needsDoctor: item.state.needsDoctor,
        needsFamilyAlert: item.state.needsFamilyAlert,
        followUpHours: item.state.followUpHours,
      })
    ).toBe(before);
    expect(facts.care_level).toBe(
      item.state.needsDoctor
        ? item.state.severity === 'high'
          ? 'kham_trong_ngay'
          : 'dat_lich_kham'
        : 'tu_theo_doi'
    );
  }
);
