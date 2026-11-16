const {
  buildCitationOptions,
  resolveCitationOptions,
} = require('../src/services/integrations/doctor-citation-options');
const { validateGroundedCitations } = require('../src/services/integrations/doctor-copilot.schema');
const chunks = [
  {
    source_id: 'source',
    chunk_id: 'chunk',
    content:
      '[ASINU editorial search labels: đau bụng]\nBEGIN ORIGINAL SOURCE TEXT\nSee a GP if the symptoms persist.\nEND ORIGINAL SOURCE TEXT',
  },
];
test('selecting a supplied passage resolves to the original source and exact quote', () => {
  const options = buildCitationOptions(chunks);
  const result = resolveCitationOptions({ citation_ids: ['S1P1'], citations: [] }, options);
  expect(result.citations).toEqual([
    { source_id: 'source', chunk_id: 'chunk', quote: 'See a GP if the symptoms persist.' },
  ]);
  expect(validateGroundedCitations(result.citations, chunks)).toEqual([]);
});
test('unknown passage IDs fail and absent selections do not create automatic citations', () => {
  const options = buildCitationOptions(chunks);
  expect(() => resolveCitationOptions({ citation_ids: ['S99P1'] }, options)).toThrow(
    'unknown clinical citation'
  );
  expect(resolveCitationOptions({ citations: [] }, options).citations).toEqual([]);
});
test('long source text remains available in bounded original passages', () => {
  const content = Array.from({ length: 400 }, (_, i) => `sourceword${i}`).join(' ');
  const source = { source_id: 'source', chunk_id: 'chunk', content };
  const options = buildCitationOptions([source]);
  expect(options[0].options.every((o) => o.quote.length <= 480 && content.includes(o.quote))).toBe(
    true
  );
  for (let i = 0; i < 400; i++)
    expect(options[0].options.some((o) => o.quote.includes(`sourceword${i}`))).toBe(true);
});
