const {
  validateGroundedCitations,
  quotableClinicalText,
} = require('../src/services/integrations/doctor-copilot.schema');
const body =
  '[ASINU editorial search labels, not source recommendations: đau bụng]\nBEGIN ORIGINAL SOURCE TEXT\nSee a GP if your symptoms persist.\nEND ORIGINAL SOURCE TEXT\n[Source: https://www.nhs.uk/]';
const chunk = { source_id: 'source', chunk_id: 'chunk', content: body };
test('editorial search labels cannot be used as clinical evidence', () => {
  expect(
    validateGroundedCitations(
      [{ source_id: 'source', chunk_id: 'chunk', quote: 'đau bụng' }],
      [chunk]
    )
  ).toHaveLength(1);
  expect(
    validateGroundedCitations(
      [{ source_id: 'source', chunk_id: 'chunk', quote: 'See a GP if your symptoms persist.' }],
      [chunk]
    )
  ).toEqual([]);
});
test('original source text survives a chunk boundary while following metadata is excluded', () => {
  expect(
    quotableClinicalText(
      'Original continuation.\nEND ORIGINAL SOURCE TEXT\n[ASINU editorial search labels: not evidence]\nBEGIN ORIGINAL SOURCE TEXT\nNext original section.'
    )
  ).toBe('Original continuation.\n\n\nNext original section.');
});
test('plain existing source chunks remain quotable', () => {
  expect(quotableClinicalText('Measure after resting.')).toBe('Measure after resting.');
});
