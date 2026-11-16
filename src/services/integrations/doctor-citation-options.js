const { quotableClinicalText } = require('./doctor-copilot.schema');

// The model selects a passage ID; the server supplies its exact quote and UUIDs.
// This avoids asking the model to transcribe long quotes or source identifiers.
const buildCitationOptions = (chunks = []) =>
  chunks.map((chunk, index) => {
    const body = quotableClinicalText(chunk.content);
    const options = [];
    for (let offset = 0; offset < body.length; ) {
      let end = Math.min(offset + 480, body.length);
      if (end < body.length) {
        const boundary = body.lastIndexOf(' ', end);
        if (boundary > offset + 200) end = boundary;
      }
      const quote = body.slice(offset, end).trim();
      if (quote) options.push({ citation_id: `S${index + 1}P${options.length + 1}`, quote });
      offset = end;
    }
    return { ...chunk, options };
  });

const resolveCitationOptions = (raw, options) => {
  if (raw.citation_ids === undefined) return raw;
  const index = new Map(
    options.flatMap((chunk) =>
      chunk.options.map((option) => [
        option.citation_id,
        { source_id: chunk.source_id, chunk_id: chunk.chunk_id, quote: option.quote },
      ])
    )
  );
  if (
    !Array.isArray(raw.citation_ids) ||
    raw.citation_ids.length > 12 ||
    raw.citation_ids.some((id) => typeof id !== 'string' || !index.has(id))
  ) {
    const error = new Error('The AI selected an unknown clinical citation passage.');
    error.code = 'DOCTOR_AI_CITATION_INVALID';
    error.statusCode = 502;
    error.retryInstruction =
      'Select only citation_id values supplied in approved_knowledge.citation_options. Do not invent a passage ID, quote or source identifier.';
    throw error;
  }
  const citations = [
    ...(Array.isArray(raw.citations) ? raw.citations : []),
    ...[...new Set(raw.citation_ids)].map((id) => index.get(id)),
  ];
  const unique = new Map(citations.map((citation) => [JSON.stringify(citation), citation]));
  return { ...raw, citations: [...unique.values()] };
};
module.exports = { buildCitationOptions, resolveCitationOptions };
