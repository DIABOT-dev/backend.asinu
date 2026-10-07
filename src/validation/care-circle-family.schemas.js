'use strict';

const { z } = require('zod');
const { normalizeFamilyRelationship } = require('./family-relationships');

const DEFAULT_FAMILY_ROLE = 'than-nhan';
const careCircleRelationshipSchema = z.preprocess(normalizeFamilyRelationship, z.string().max(255).optional());

// Older app versions sent translated labels. Persist stable IDs for both languages.
const FAMILY_ROLE_ALIASES = new Map([
  ...['than-nhan', 'thân nhân', 'người thân', 'gia đình', 'relative', 'family member', 'family']
    .map((value) => [value, 'than-nhan']),
  ...[
    'nguoi-cham-soc',
    'người chăm sóc',
    'người chăm sóc chính',
    'người thân chăm sóc chính',
    'primary caregiver',
    'family caregiver',
    'caregiver',
  ].map((value) => [value, DEFAULT_FAMILY_ROLE]),
]);

const careCircleFamilyRoleSchema = z.preprocess((value) => {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value;
  const label = value.normalize('NFC').trim();
  if (!label) return undefined;
  return FAMILY_ROLE_ALIASES.get(label.toLowerCase()) || label;
}, z.literal(DEFAULT_FAMILY_ROLE).optional());

const careCircleInvitationRoleSchema = careCircleFamilyRoleSchema.transform(value => value ?? DEFAULT_FAMILY_ROLE);

const careCircleConnectionUpdateSchema = z.object({
  relationship_type: careCircleRelationshipSchema,
  role: careCircleFamilyRoleSchema,
}).refine((data) => data.relationship_type !== undefined || data.role !== undefined, {
  message: 'careCircle.need_at_least_one_field',
});

function familyRoleError(lang) {
  const { t } = require('../i18n');
  return {
    ok: false,
    statusCode: 400,
    code: 'CARE_CIRCLE_FAMILY_ROLE_REQUIRED',
    error: t('careCircle.family_role_required', lang),
  };
}

module.exports = {
  DEFAULT_FAMILY_ROLE, careCircleRelationshipSchema, careCircleFamilyRoleSchema,
  careCircleInvitationRoleSchema, careCircleConnectionUpdateSchema, familyRoleError,
};
