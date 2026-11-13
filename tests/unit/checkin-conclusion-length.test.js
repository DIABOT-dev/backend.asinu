'use strict';

jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
const { callTextAi } = require('../../src/services/ai/ai.service');
const logger = require('../../src/lib/logger');
const {
  generateNarrativeConclusion,
} = require('../../src/core/checkin/triage-conclusion-narrative');
const { conclusionSpeech } = require('../../src/core/checkin/triage-conclusion-speech');
const { withCheckinAiWait } = require('../../src/services/ai/checkin-wait-policy.service');
const state = {
  allSymptoms: ['khó ngủ'],
  currentSymptoms: ['khó ngủ'],
  onset: 'vài ngày nay',
  progression: 'same',
  completedSteps: new Set(['red_flags']),
  redFlagsFound: [],
  actionsFound: [],
  severity: 'medium',
  needsDoctor: true,
  followUpHours: 3,
};
const profile = { age: 52, gender: 'Nam', medical_conditions: [] };

function prose(lang = 'vi') {
  let text =
    lang === 'en'
      ? 'You have been having trouble sleeping for a few days.\n\n'
      : 'Chú đang khó ngủ vài ngày nay, cháu hiểu chú đang mệt.\n\n';
  for (let index = 0; text.length < 2100; index++)
    text +=
      lang === 'en'
        ? `Observation ${index + 1}: A regular routine helps you keep track of changes in your day.\n\n`
        : `Gợi ý ${index + 1}: Nếp sinh hoạt đều đặn giúp mình ghi nhận thay đổi trong ngày.\n\n`;
  return (
    text +
    (lang === 'en'
      ? '- Please arrange an assessment over the next few days.'
      : '- Chú nên đi khám trong vài ngày tới.')
  );
}

beforeEach(() => jest.clearAllMocks());

test.each(['vi', 'en'])(
  '%s main conclusion targets 2000–4000 characters and reads every final instruction',
  async (lang) => {
    const value = prose(lang);
    callTextAi.mockResolvedValue({
      content: value,
      finishReason: 'stop',
      model: 'medgemma-27b-it',
    });
    const result = await generateNarrativeConclusion(state, profile, lang);
    expect(result.conclusionSource).toBe('ai');
    expect(result.narrative.length).toBeGreaterThanOrEqual(2000);
    expect(result.narrative.length).toBeLessThanOrEqual(4000);
    expect(result.speechText).toBe(conclusionSpeech(result));
    expect(result.speechText).toContain(
      lang === 'en' ? 'Please arrange an assessment' : 'Chú nên đi khám'
    );
    expect(result.speechText).toContain(result.disclaimer);
    expect(result.speechText).toContain(result.aiNotice);
    expect(callTextAi).toHaveBeenCalledTimes(1);
    expect(callTextAi.mock.calls[0][0]).toMatchObject({
      provider: 'medgemma',
      strictProvider: true,
      maxTokens: 1800,
      maxRetries: 0,
    });
    expect(callTextAi.mock.calls[0][0].system).toContain('2000–4000');
  }
);

test('one compact rewrite accounts for both provider calls and keeps the tail warning', async () => {
  const tail = '- Nếu khó ngủ ảnh hưởng nhiều tới sinh hoạt, chú nên đi khám sớm hơn.';
  callTextAi
    .mockResolvedValueOnce({
      content: prose() + '\n\n' + prose() + '\n\n' + tail,
      usage: { total: 1800, completion: 800 },
    })
    .mockResolvedValueOnce({
      content: prose(),
      usage: { total: 1500, completion: 700 },
      finishReason: 'stop',
    });
  const result = await generateNarrativeConclusion(state, profile);
  expect(result.narrative.length).toBeLessThanOrEqual(4000);
  expect(result.narrative).toContain(tail);
  expect(result.speechText).toContain(tail.replace(/^- /, ''));
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(logger.info).toHaveBeenCalledWith(
    'conclusion_generated',
    expect.objectContaining({
      requests: 2,
      tokens: 3300,
      completionTokens: 1500,
      compactReason: 'narrative_too_long',
    })
  );
});

test('a complete compact interview with a thin explanation gets one grounded expansion, not fabricated filler', async () => {
  callTextAi
    .mockResolvedValueOnce({
      content:
        'Chú đang khó ngủ vài ngày nay. Chú nên giữ giờ ngủ đều và đi khám trong vài ngày tới.',
      finishReason: 'stop',
    })
    .mockResolvedValueOnce({ content: prose(), finishReason: 'stop' });
  const result = await generateNarrativeConclusion(
    {
      ...state,
      assessmentIncomplete: false,
      compactAssessment: {
        complete: true,
        interviewRevision: 2,
        concerns: [],
        global: {},
        answers: [],
        missing: [],
      },
    },
    profile
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative.length).toBeGreaterThanOrEqual(2000);
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(callTextAi.mock.calls[1][0].prompt).toContain('Không thêm dữ kiện người bệnh');
  expect(logger.info).toHaveBeenCalledWith(
    'conclusion_generated',
    expect.objectContaining({ compactReason: 'narrative_too_short', lengthTargetMet: true })
  );
});

test('a validated rewrite above the length target keeps the complete AI result instead of replacing it with a short fallback', async () => {
  const tail = '- Nếu khó ngủ ảnh hưởng nhiều tới sinh hoạt, chú nên đi khám sớm hơn.';
  callTextAi.mockResolvedValue({
    content: prose() + '\n\n' + prose() + '\n\n' + tail,
    usage: { total: 10, completion: 5 },
    finishReason: 'stop',
  });
  const result = await generateNarrativeConclusion(state, profile);
  expect(callTextAi).toHaveBeenCalledTimes(2);
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative.length).toBeGreaterThan(4000);
  expect(result.narrative).toContain(tail);
  expect(result.speechText).toBe(conclusionSpeech(result));
  expect(logger.info).toHaveBeenCalledWith(
    'conclusion_generated',
    expect.objectContaining({
      requests: 2,
      tokens: 20,
      compactReason: 'narrative_too_long',
      lengthTargetMet: false,
    })
  );
});

test('uncertainty in a provider fallback does not claim that answered questions were never asked', async () => {
  callTextAi.mockRejectedValue(new Error('offline'));
  const result = await generateNarrativeConclusion(
    { ...state, assessmentIncomplete: true },
    profile
  );
  expect(result.conclusionSource).toBe('fallback');
  expect(result.narrative).toContain('Một số thông tin vẫn chưa rõ');
  expect(result.narrative).not.toContain('chưa hỏi được kỹ');
});

test('a generated explanation cannot turn reported numbness into confirmed nerve damage or reintroduce Asinu', async () => {
  callTextAi.mockResolvedValue({
    content:
      'Chào chú, cháu là Asinu đây. Chú có kể bàn chân phải bị tê. Đây là tình trạng các dây thần kinh bị tổn thương, gây ra cảm giác tê. Chú nên đi khám trong vài ngày tới.',
    finishReason: 'stop',
  });
  const result = await generateNarrativeConclusion(
    { ...state, allSymptoms: ['Tê bàn chân phải'], currentSymptoms: ['Tê bàn chân phải'] },
    profile
  );
  expect(result.conclusionSource).toBe('ai');
  expect(result.narrative).not.toContain('là Asinu');
  expect(result.narrative).not.toContain('các dây thần kinh bị tổn thương');
  expect(result.narrative).toContain('bàn chân phải bị tê');
  expect(result.narrative).toContain('đi khám');
});

test('compact rewriting uses only the remaining sixty-second AI budget', async () => {
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    callTextAi
      .mockImplementationOnce(async () => {
        now += 55_000;
        return { content: prose() + '\n\n' + prose() };
      })
      .mockResolvedValueOnce({ content: prose(), finishReason: 'stop' });
    const result = await generateNarrativeConclusion(state, profile);
    expect(result.conclusionSource).toBe('ai');
    expect(callTextAi.mock.calls[1][0].timeoutMs).toBe(5000);
  } finally {
    clock.mockRestore();
  }
});

test('an exhausted AI deadline does not start another request or fabricate content to reach the minimum', async () => {
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    callTextAi.mockImplementationOnce(async () => {
      now += 60_001;
      return { content: prose() + '\n\n' + prose() };
    });
    const result = await generateNarrativeConclusion(state, profile);
    expect(callTextAi).toHaveBeenCalledTimes(1);
    expect(result.conclusionSource).toBe('fallback');
    expect(result.narrative.length).toBeLessThan(2000);
    expect(result.speechText).toBe(conclusionSpeech(result));
  } finally {
    clock.mockRestore();
  }
});

test('the interactive wait policy accepts a valid conclusion after the former 60-second deadline', async () => {
  let now = 1000;
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    callTextAi.mockImplementationOnce(async () => {
      now += 125000;
      return { content: prose(), finishReason: 'stop' };
    });
    const result = await withCheckinAiWait(() => generateNarrativeConclusion(state, profile), async () => {});
    expect(result.conclusionSource).toBe('ai');
    expect(result.narrative).toContain('khó ngủ');
    expect(result.speechText).toBe(conclusionSpeech(result));
  } finally { clock.mockRestore(); }
});
