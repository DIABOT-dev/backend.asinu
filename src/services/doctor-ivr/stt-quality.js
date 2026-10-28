'use strict';
// A model likelihood is an estimate, not a calibrated probability of clinical
// correctness. Missing scores remain null; the original recording is authoritative.
function transcriptionResult(data) {
  const tokenLogs = (data.logprobs || []).map((v) => v.logprob).filter(Number.isFinite);
  const segments = (data.segments || []).filter((v) => Number.isFinite(v.avg_logprob));
  let mean = null;
  if (tokenLogs.length) mean = tokenLogs.reduce((a, b) => a + b, 0) / tokenLogs.length;
  else if (segments.length) {
    const weight = (v) => Math.max(1, Array.isArray(v.tokens) ? v.tokens.length : 1);
    mean =
      segments.reduce((a, v) => a + v.avg_logprob * weight(v), 0) /
      segments.reduce((a, v) => a + weight(v), 0);
  }
  const confidence = mean === null ? null : Math.min(1, Math.max(0, Math.exp(mean)));
  const noSpeech =
    segments.length > 0 &&
    segments.every((v) => Number.isFinite(v.no_speech_prob) && v.no_speech_prob >= 0.6);
  return {
    text: String(data.text || '').trim(),
    confidence,
    confidence_source: mean === null ? null : 'model_likelihood_estimate',
    needs_review:
      noSpeech || confidence === null || confidence < 0.6 || !String(data.text || '').trim(),
  };
}
module.exports = { transcriptionResult };
