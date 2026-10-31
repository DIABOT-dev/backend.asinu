'use strict';
const p = require('../../src/services/v21/medication.policy');
const med = require('../../src/services/v21/medication.service');
const { normalizeScan } = require('../../src/services/v21/medication-scan.service');
const audio = require('../../src/services/v21/audio.service');
test.each([
  [1, 'TAKEN'],
  [2, 'SKIPPED'],
  [3, 'OUT_OF_MEDS'],
])('button %s is deterministic', (button, state) => {
  expect(p.nextState(button)).toBe(state);
  expect(p.terminal).toContain(state);
});
test.each(['06:59', '21:00', '23:59'])(
  'does not call outside the 07:00–21:00 window: %s',
  (time) => {
    expect(p.inCallWindow(new Date('2026-10-30T' + time + ':00+07:00'), 'Asia/Ho_Chi_Minh')).toBe(
      false
    );
  }
);
test.each(['07:00', '12:30', '20:59'])('call window accepts %s', (time) => {
  expect(p.inCallWindow(new Date('2026-10-30T' + time + ':00+07:00'), 'Asia/Ho_Chi_Minh')).toBe(
    true
  );
});
test('meal anchors preserve midnight wrapping and do not require a typed minute', () => {
  expect(p.anchorTime('after_breakfast', { breakfast: '07:00' })).toBe('07:30');
  expect(p.anchorTime('before_breakfast', { breakfast: '00:15' })).toBe('23:45');
});
test('local conversion uses the patient timezone and rejects nonexistent DST minutes', () => {
  expect(p.atLocal('2026-10-30', '07:30', 'Asia/Ho_Chi_Minh').toISOString()).toBe(
    '2026-10-30T00:30:00.000Z'
  );
  expect(p.atLocal('2026-03-08', '02:30', 'America/New_York')).toBeNull();
});
test('item confirmation is mandatory and dose strengths cannot be saved', () => {
  const x = { display_name: 'Thuốc huyết áp', kind: 'MEDICINE', source: 'CHIP', confirmed: true };
  expect(med.itemSchema.safeParse(x).success).toBe(true);
  expect(med.itemSchema.safeParse({ ...x, confirmed: false }).success).toBe(false);
  expect(med.itemSchema.safeParse({ ...x, display_name: 'Amlor 5mg' }).success).toBe(false);
  expect(med.itemSchema.safeParse({ ...x, dose: '2 viên' }).success).toBe(false);
});
test('scan output strips dose/identity fields, does not infer time from packaging, and deduplicates a brand', () => {
  const item = {
    printed_name: 'Amlor 5mg',
    display_name: 'Amlor 5mg',
    kind: 'MEDICINE',
    suggested_slots: ['morning'],
    dose: '2 viên',
    patient_name: 'Private name',
  };
  const out = normalizeScan(JSON.stringify({ document_type: 'PACKAGING', items: [item, item] }));
  expect(out.items).toHaveLength(1);
  expect(out.items[0]).toMatchObject({
    printed_name: 'Amlor',
    display_name: 'Amlor',
    suggested_slots: [],
    confirmed: false,
  });
  expect(JSON.stringify(out)).not.toMatch(/Private name|dose|5mg|2 viên/);
});
test('an unreadable side becomes a safe manual fallback even if optional provider metadata is absent', () => {
  expect(normalizeScan('{"readable":false,"document_type":"OTHER","items":[]}')).toMatchObject({
    readable: false,
    items: [],
  });
});
test('a long display name requires review instead of truncating medication identity', () => {
  const out = normalizeScan(
    JSON.stringify({
      document_type: 'PACKAGING',
      items: [
        {
          printed_name: 'Doppelherz aktiv Magnesium + Calcium + D3',
          display_name: 'Doppelherz aktiv Magnesium + Ca',
          kind: 'SUPPLEMENT',
        },
      ],
    })
  );
  expect(out.items[0].display_name).toBeNull();
  expect(out.items[0].needs_name_review).toBe(true);
  expect(out.items[0].printed_name).toContain('D3');
});
test('partial prescriptions keep only valid explicit slot labels and never any dose fields', () => {
  const out = normalizeScan(
    JSON.stringify({
      document_type: 'PRESCRIPTION',
      items: [
        {
          printed_name: 'Concor',
          display_name: 'Concor',
          kind: 'MEDICINE',
          suggested_slots: ['morning', 'inferred noon', '18:30'],
          mg: 5,
        },
      ],
    })
  );
  expect(out.items[0].suggested_slots).toEqual(['morning']);
  expect(out.items[0]).not.toHaveProperty('mg');
});
test.each(['null', '[]', 'not json', '{"items":null}'])('malformed scan %s is rejected', (raw) => {
  expect(() => normalizeScan(raw)).toThrow();
});
test('every fixed TTS phase uses the new skip choice, never medicine names or dosage', () => {
  expect(audio.phrase('prompt')).toContain('bỏ qua');
  expect(audio.phrase('prompt')).not.toContain('lát nữa');
  for (const phrase of Object.values(audio.PHRASES).flatMap(Object.values))
    expect(phrase).not.toMatch(/Amlor|Concor|Metformin|\bmg\b|microphone|ghi âm/i);
});

test.each(['Thuốc 1 g', 'Thuốc 10 units', 'Thuốc 5 U'])(
  'manual name must not retain dose quantity %s',
  (name) => {
    expect(med.nameSchema.safeParse(name).success).toBe(false);
  }
);
