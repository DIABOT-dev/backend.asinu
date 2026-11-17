'use strict';

// Older clinical callers still select the medgemma adapter and its model IDs.
// Resolve them here so migrating the endpoint also migrates every such caller.
function getClinicalConfig({ provider, model, vision = false } = {}) {
  const useRouter =
    provider === '9router' ||
    process.env.AI_PROVIDER_CLINICAL === '9router' ||
    Boolean(process.env.NINEROUTER_ENDPOINT);
  if (useRouter) {
    const legacyModel =
      !model || /^(?:medgemma(?:-|$)|med-gemini$|baichuan-m3$|clinical-camel$)/.test(model);
    return {
      provider: '9router',
      endpoint: process.env.NINEROUTER_ENDPOINT || '',
      apiKey: process.env.NINEROUTER_API_KEY || '',
      model: legacyModel
        ? (vision && process.env.NINEROUTER_VISION_MODEL) || process.env.NINEROUTER_MODEL || ''
        : model,
      supportsJsonMode: process.env.NINEROUTER_SUPPORTS_JSON_MODE === 'true',
    };
  }
  return {
    provider: 'medgemma',
    endpoint: process.env.MEDGEMMA_ENDPOINT || '',
    apiKey: process.env.MEDGEMMA_API_KEY || '',
    model: model || (vision ? 'med-gemini' : process.env.MEDGEMMA_MODEL || 'medgemma-4b-it'),
    supportsJsonMode: process.env.MEDGEMMA_SUPPORTS_JSON_MODE === 'true',
  };
}

function isClinicalConfigured(provider) {
  const config = getClinicalConfig({ provider });
  return Boolean(
    config.endpoint && (config.provider !== '9router' || (config.apiKey && config.model))
  );
}

module.exports = { getClinicalConfig, isClinicalConfigured };
