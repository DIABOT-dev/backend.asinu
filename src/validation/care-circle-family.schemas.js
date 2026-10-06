'use strict';

const { z } = require('zod');

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
  ].map((value) => [value, 'nguoi-cham-soc']),
]);

const careCircleFamilyRoleSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const label = value.normalize('NFC').trim();
  if (!label) return null;
  return FAMILY_ROLE_ALIASES.get(label.toLowerCase()) || label;
}, z.enum(['than-nhan', 'nguoi-cham-soc']).nullable().optional());

const careCircleConnectionUpdateSchema = z.object({
  relationship_type: z.string().max(255).optional(),
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

module.exports = { careCircleFamilyRoleSchema, careCircleConnectionUpdateSchema, familyRoleError };
