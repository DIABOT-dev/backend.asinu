/**
 * Per-provider token cost estimates. All prices in USD per 1K tokens.
 *
 * Numbers are rough and should be re-checked quarterly. They exist so the
 * logged `estimated_cost` is "good enough" for trend analysis without
 * pulling exact billing data from each provider.
 *
 * If a model isn't listed, the cost falls back to 0 so we never crash a
 * request just because pricing data is missing.
 */

const PRICING = {
  // OpenAI — https://openai.com/api/pricing/
  'gpt-4o':              { input: 0.0025, output: 0.01 },
  'gpt-4o-mini':         { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo':         { input: 0.01, output: 0.03 },
  'gpt-3.5-turbo':       { input: 0.0005, output: 0.0015 },
  'whisper-1':           { input: 0, output: 0, perMinute: 0.006 },
  'phowhisper':          { input: 0, output: 0, perMinute: 0 },
  'diepho/PhoWhisper-medium-ct2': { input: 0, output: 0, perMinute: 0 },

  // Google — Gemini & MedGemma
  'gemini-2.0-flash':    { input: 0.00010, output: 0.00040 },
  'gemini-1.5-pro':      { input: 0.00125, output: 0.00500 },
  'medgemma-27b-text-it':{ input: 0.00015, output: 0.00060 }, // placeholder until Vertex pricing is firm

  // DiaBrain (internal, no marginal cost)
  'diabrain':            { input: 0, output: 0 },
};

function estimateCost({ provider, model, inputTokens, outputTokens } = {}) {
  if (!model && !provider) return null;
  const pricing = PRICING[model] || PRICING[provider];
  if (!pricing) return null;

  const inK  = (inputTokens  || 0) / 1000;
  const outK = (outputTokens || 0) / 1000;
  const cost = inK * (pricing.input || 0) + outK * (pricing.output || 0);
  return Number(cost.toFixed(6));
}

module.exports = { estimateCost, PRICING };
