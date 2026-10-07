'use strict';

const { FAMILY_RELATIONSHIPS, findFamilyRelationship, normalizeFamilyRelationship } = require('../../src/validation/family-relationships');
const { careCircleRelationshipSchema, careCircleConnectionUpdateSchema } = require('../../src/validation/care-circle-family.schemas');
const { careCircleInvitationSchema, careCircleQrInvitationSchema } = require('../../src/validation/validation.schemas');
const { relationshipForRecipient } = require('../../src/services/checkin-call/family-contact.service');
const { getPatientRoleForCaregiver } = require('../../src/lib/relation');
const { t } = require('../../src/i18n');

test('all 54 family relationships have unique stable ids', () => {
  expect(FAMILY_RELATIONSHIPS).toHaveLength(54);
  expect(new Set(FAMILY_RELATIONSHIPS.map(option => option.id)).size).toBe(54);
  for (const id of ['ong-noi', 'ba-noi', 'ong-ngoai', 'ba-ngoai', 'chau', 'bo', 'me',
    'anh-trai', 'chi-gai', 'em-trai', 'em-gai', 'chu', 'di', 'co', 'bac-trai', 'bac-gai', 'cau',
    'mo', 'thim', 'duong', 'con-dau', 'con-re', 'bo-vo', 'me-chong', 'anh-ho', 'chat']) {
    expect(findFamilyRelationship(id)?.id).toBe(id);
  }
});

describe.each(['vi', 'en'])('%s relationship contract', lang => {
  test.each(FAMILY_RELATIONSHIPS)('$id: labels normalize for invitations, QR and updates', option => {
    const label = t('careCircle.relationship.' + option.labelKey, lang);
    expect(label).not.toMatch(/^careCircle\./);
    expect(findFamilyRelationship(label)?.id).toBe(option.id);
    expect(normalizeFamilyRelationship(label.normalize('NFD'))).toBe(option.id);
    for (const value of [option.id, label]) {
      expect(careCircleRelationshipSchema.parse(value)).toBe(option.id);
      expect(careCircleInvitationSchema.parse({ addressee_id: '8', relationship_type: value }))
        .toMatchObject({ relationship_type: option.id, role: 'than-nhan' });
      expect(careCircleQrInvitationSchema.parse({ token: 'x'.repeat(43), relationship_type: value }))
        .toMatchObject({ relationship_type: option.id, role: 'than-nhan' });
      const update = careCircleConnectionUpdateSchema.parse({ relationship_type: value });
      expect(update.relationship_type).toBe(option.id);
      expect(update.role).toBeUndefined();
    }
  });
  test.each(FAMILY_RELATIONSHIPS)('$id: family calls never speak an internal id or missing key', option => {
    for (const forward of [true, false]) for (const gender of [undefined, 'Nam', 'Nữ']) {
      const spoken = relationshipForRecipient(option.id, forward, gender, lang);
      expect(spoken).not.toMatch(/careCircle\.|checkinCall\.|undefined|null|\{\{/);
      expect(spoken).not.toMatch(new RegExp('(^|\\s)' + option.id + '(?=\\s|$)'));
      expect(spoken.length).toBeGreaterThan(0);
    }
  });
});

test('custom legacy relationships are retained but cannot bypass type or length checks', () => {
  expect(careCircleRelationshipSchema.parse('  Người trong gia đình lớn  ')).toBe('Người trong gia đình lớn');
  expect(careCircleRelationshipSchema.safeParse({ id: 'co' }).success).toBe(false);
  expect(careCircleRelationshipSchema.safeParse('x'.repeat(256)).success).toBe(false);
  expect(careCircleConnectionUpdateSchema.safeParse({}).success).toBe(false);
});

test.each([
  ['con-trai', 'Bố/mẹ Lan'], ['anh-trai', 'Em Lan'], ['ong-noi', 'Cháu Lan'],
  ['di', 'Cháu (con của anh/chị/em) Lan'], ['cu-ba', 'Chắt Lan'],
])('notification role naming supports canonical %s without guessing gender', (id, expected) => {
  expect(getPatientRoleForCaregiver(id, 'Lan', 'vi', true)).toBe(expected);
  expect(getPatientRoleForCaregiver(id, 'Lan', 'en', true)).toBe('Lan');
});
