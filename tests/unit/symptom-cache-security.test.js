jest.mock('../../src/lib/redis', () => ({ cacheGet: jest.fn(), cacheSet: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ debug: jest.fn(), warn: jest.fn() }));
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn(async () => ({ choices: [{ message: { content: '{}' } }] })) } },
})));
const { cacheGet, cacheSet } = require('../../src/lib/redis');
const { analyzeSymptom } = require('../../src/core/agent/ai-symptom-analyzer');
const logger = require('../../src/lib/logger');
const originalEnforcement = process.env.AI_CONSENT_ENFORCEMENT;
beforeEach(() => { jest.clearAllMocks(); process.env.AI_CONSENT_ENFORCEMENT = 'false'; });
afterAll(() => {
  if (originalEnforcement === undefined) delete process.env.AI_CONSENT_ENFORCEMENT;
  else process.env.AI_CONSENT_ENFORCEMENT = originalEnforcement;
});
test('identical narratives cannot reuse a different patient or clinical context cache', async () => {
  cacheGet.mockImplementation(async key => ({ fixtureKey: key }));
  const narrative = 'private synthetic narrative';
  const first = await analyzeSymptom(narrative, { userId: 1, age: 30 });
  const same = await analyzeSymptom(narrative, { userId: 1, age: 30 });
  const other = await analyzeSymptom(narrative, { userId: 2, age: 30 });
  const changed = await analyzeSymptom(narrative, { userId: 1, age: 80 });
  expect(same).toEqual(first);
  expect(other).not.toEqual(first);
  expect(changed).not.toEqual(first);
  for (const [key] of cacheGet.mock.calls) {
    expect(key).not.toContain(narrative);
    expect(key).toMatch(/^sym:v2:analysis:user:[12]:[a-f0-9]{64}$/);
  }
  expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(narrative);
});
test('analysis without a trusted account identity cannot read or populate a shared patient cache', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await analyzeSymptom('private synthetic narrative', {});
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
