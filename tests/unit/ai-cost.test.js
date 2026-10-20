const { estimateCost } = require('../../src/services/ai/ai-cost.service');

describe('estimateCost', () => {
  test('returns null when neither provider nor model known', () => {
    expect(estimateCost({ model: 'mystery', provider: 'unknown' })).toBeNull();
  });

  test('computes gpt-4o-mini cost', () => {
    // 1000 input + 500 output = 0.001 * 0.15 + 0.5 * 0.6 / 1000
    // input: 1.0 * 0.00015 = 0.00015
    // output: 0.5 * 0.0006 = 0.0003
    // total = 0.00045
    const cost = estimateCost({ model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    expect(cost).toBeCloseTo(0.00045, 5);
  });

  test('handles missing tokens (returns 0)', () => {
    const cost = estimateCost({ model: 'gpt-4o' });
    expect(cost).toBe(0);
  });

  test('handles diabrain free provider', () => {
    expect(estimateCost({ model: 'diabrain', inputTokens: 9999, outputTokens: 9999 })).toBe(0);
  });

  test.each([
    ['medgemma-4b-it', 0.002],
    ['medgemma-27b-it', 0.006],
  ])('estimates the configured DR7 token prices for %s', (model, expected) => {
    expect(
      estimateCost({ provider: 'medgemma', model, inputTokens: 1000, outputTokens: 500 })
    ).toBe(expected);
  });
});
