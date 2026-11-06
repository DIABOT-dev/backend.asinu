'use strict';

jest.mock('../../src/core/checkin/triage-conclusion', () => ({
  generateStructuredConclusion: jest.fn(async () => ({
    personalMessage: 'Synthetic approved path',
  })),
  isSafeConclusion: jest.fn(),
}));
const { generateStructuredConclusion } = require('../../src/core/checkin/triage-conclusion');
const { structuredConclusionEnabled } = require('../../src/core/checkin/triage-conclusion-release');
const {
  generateConclusion,
  EMERGENCY_CONCLUSIONS,
} = require('../../src/core/checkin/triage-ai-layer');

const original = {
  NODE_ENV: process.env.NODE_ENV,
  CHECKIN_STRUCTURED_CONCLUSION_ENABLED: process.env.CHECKIN_STRUCTURED_CONCLUSION_ENABLED,
};
const state = {
  allSymptoms: ['mệt'],
  onset: 'hôm nay',
  progression: 'same',
  severity: 'low',
  needsDoctor: false,
  followUpHours: 6,
};
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.clearAllMocks();
});

test.each(['production', 'staging', undefined])(
  'unset flag does not release SRS content in %s',
  (NODE_ENV) => {
    expect(structuredConclusionEnabled({ NODE_ENV })).toBe(false);
  }
);
test.each(['development', 'test'])(
  'local %s can evaluate the new result before release',
  (NODE_ENV) => {
    expect(structuredConclusionEnabled({ NODE_ENV })).toBe(true);
  }
);
test.each(['false', '0', '', 'TRUE', 'invalid'])('explicit value %j stays disabled', (value) => {
  expect(
    structuredConclusionEnabled({
      NODE_ENV: 'development',
      CHECKIN_STRUCTURED_CONCLUSION_ENABLED: value,
    })
  ).toBe(false);
});
test.each(['true', '1'])('an explicit release decision %j enables production', (value) => {
  expect(
    structuredConclusionEnabled({
      NODE_ENV: 'production',
      CHECKIN_STRUCTURED_CONCLUSION_ENABLED: value,
    })
  ).toBe(true);
});
test.each(['vi', 'en'])(
  'production pending review retains the legacy %s contract without a model call',
  async (lang) => {
    process.env.NODE_ENV = 'production';
    delete process.env.CHECKIN_STRUCTURED_CONCLUSION_ENABLED;
    const result = await generateConclusion(state, { age: 40 }, lang);
    expect(Object.keys(result).sort()).toEqual([
      'closeMessage',
      'isEmergency',
      'recommendation',
      'summary',
    ]);
    expect(result.summary).toBeTruthy();
    expect(result.recommendation).toBeTruthy();
    expect(result.closeMessage).toContain('6');
    expect(result.isEmergency).toBe(false);
    expect(generateStructuredConclusion).not.toHaveBeenCalled();
  }
);
test('explicit enable forwards the original facts without changing the triage decision', async () => {
  process.env.NODE_ENV = 'production';
  process.env.CHECKIN_STRUCTURED_CONCLUSION_ENABLED = 'true';
  const profile = { age: 40 },
    context = { recentBP: [] };
  await expect(generateConclusion(state, profile, 'vi', null, context)).resolves.toEqual({
    personalMessage: 'Synthetic approved path',
  });
  expect(generateStructuredConclusion).toHaveBeenCalledWith(state, profile, 'vi', context);
});
test.each(Object.keys(EMERGENCY_CONCLUSIONS))(
  'emergency %s keeps the fixed result with release flag off',
  async (emergencyType) => {
    process.env.NODE_ENV = 'production';
    process.env.CHECKIN_STRUCTURED_CONCLUSION_ENABLED = 'false';
    const result = await generateConclusion({ ...state, emergencyType }, { age: 40 });
    expect(result.isEmergency).toBe(true);
    expect(result.recommendation).toBeTruthy();
    expect(generateStructuredConclusion).not.toHaveBeenCalled();
  }
);
