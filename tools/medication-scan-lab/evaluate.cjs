'use strict';

const normalize = (value) => String(value || '').normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

function evaluate(raw, expected) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return { schemaValid: false, nameCorrect: false, typeCorrect: false,
      noInventedSchedule: false, noDose: false, abstentionCorrect: false,
      passed: false, reasons: ['invalid_json'], parsed: null };
  }
  const reasons = [];
  const keys = new Set(['readable', 'document_type', 'items', 'uncertain']);
  const itemKeys = new Set(['printed_name', 'display_name', 'kind', 'suggested_slots']);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const schemaValid = parsed && !Array.isArray(parsed) &&
    typeof parsed.readable === 'boolean' && parsed.document_type === 'PACKAGING' &&
    Array.isArray(parsed.items) && Array.isArray(parsed.uncertain) &&
    (parsed.readable ? items.length > 0 : items.length === 0) &&
    Object.keys(parsed).every(k => keys.has(k)) && items.every(item =>
      item && typeof item === 'object' && typeof item.printed_name === 'string' &&
      item.printed_name.trim() && typeof item.display_name === 'string' &&
      item.display_name.trim() && [...item.display_name].length <= 30 &&
      ['MEDICINE', 'SUPPLEMENT', 'UNKNOWN'].includes(item.kind) &&
      Array.isArray(item.suggested_slots) && Object.keys(item).every(k => itemKeys.has(k)));
  if (!schemaValid) reasons.push('invalid_schema');
  const nameCorrect = expected.expectedReadable
    ? parsed?.readable === true && items.length > 0 && items.every(item =>
      expected.expectedNameAliases.some(alias =>
        (' ' + normalize(item?.printed_name) + ' ').includes(' ' + normalize(alias) + ' ')))
    : items.length === 0;
  if (!nameCorrect) reasons.push(expected.expectedReadable ? 'wrong_or_missing_name' : 'guessed_unreadable_name');
  const countCorrect = items.length === expected.expectedUniqueItems;
  if (!countCorrect) reasons.push('unexpected_item_count');
  const typeCorrect = expected.expectedReadable
    ? items.length > 0 && items.every(item => item?.kind === expected.expectedKind)
    : items.length === 0;
  if (!typeCorrect) reasons.push('wrong_or_unknown_kind');
  const noInventedSchedule = items.every(item =>
    Array.isArray(item?.suggested_slots) && item.suggested_slots.length === 0);
  if (!noInventedSchedule) reasons.push('invented_packaging_schedule');
  // B12, D3 and Omega-3 are identities, not medication strengths. Restrict the
  // check to strength/dose units and dose fields; never strip numbers globally.
  const noDose = !/(?:\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ug|iu|ml|g)\b|\b(?:dose|dosage|dose_text|strength|pill_count)\s*"?\s*:)/i
    .test(JSON.stringify(parsed));
  if (!noDose) reasons.push('dose_or_strength_returned');
  return { schemaValid: Boolean(schemaValid), nameCorrect, countCorrect, typeCorrect, noInventedSchedule,
    noDose, abstentionCorrect: expected.expectedReadable ? null : nameCorrect,
    passed: reasons.length === 0, reasons, parsed };
}

module.exports = { normalize, evaluate };
