'use strict';

const { t } = require('../../i18n');
const { findFamilyRelationship, getReverseFamilyRelationshipKey } = require('../../validation/family-relationships');

function normalized(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Invitations store the addressee's relationship to the requester. Support
// both stable option IDs and the Vietnamese/English labels saved by old apps.
const RELATION_ALIASES = {
  wife: ['vo', 'wife'], husband: ['chong', 'husband'],
  mother: ['me', 'mother'], father: ['bo', 'ba', 'father'],
  son: ['con-trai', 'son'], daughter: ['con-gai', 'daughter'],
  older_brother: ['anh-trai', 'older brother'], older_sister: ['chi-gai', 'older sister'],
  younger_brother: ['em-trai', 'younger brother'], younger_sister: ['em-gai', 'younger sister'],
  paternal_grandfather: ['ong-noi', 'paternal grandfather'],
  paternal_grandmother: ['ba-noi', 'paternal grandmother'],
  maternal_grandfather: ['ong-ngoai', 'maternal grandfather'],
  maternal_grandmother: ['ba-ngoai', 'maternal grandmother'],
  grandson: ['chau-trai', 'grandson'], granddaughter: ['chau-gai', 'granddaughter'],
  friend: ['ban-than', 'best friend', 'close friend'],
  partner: ['nguoi-yeu', 'partner'], relative: ['nguoi-than', 'relative', 'family member'],
};
const RELATIONS = new Map(Object.entries(RELATION_ALIASES).flatMap(([key, aliases]) =>
  aliases.map(alias => [normalized(alias), key])
));
const NOTICE_KEYS = {
  UNKNOWN: { message: 'checkinCall.contact.message_unknown', audio: 'checkinCall.contact.audio_unknown' },
  MILD: { message: 'checkinCall.contact.message_mild', audio: 'checkinCall.contact.audio_mild' },
  URGENT: { message: 'checkinCall.contact.message_urgent', audio: 'checkinCall.contact.audio_urgent' },
};

function relationshipForRecipient(type, recipientIsRequester, subjectGender, lang) {
  let key = RELATIONS.get(normalized(type));
  if (!key) {
    const relation = findFamilyRelationship(type);
    if (relation) {
      if (relation.id === 'khac') return t('checkinCall.contact.relative', lang);
      const labelKey = recipientIsRequester ? relation.labelKey
        : getReverseFamilyRelationshipKey(relation.id, subjectGender);
      const label = t('careCircle.relationship.' + labelKey, lang);
      return t('checkinCall.contact.custom', lang, {
        relationship: lang === 'en' ? label.toLowerCase() : label,
      });
    }
    // A custom relationship cannot safely be inverted without structured data.
    const custom = typeof type === 'string' ? type.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return t(custom && recipientIsRequester ? 'checkinCall.contact.custom' : 'checkinCall.contact.relative', lang, { relationship: custom });
  }
  if (!recipientIsRequester) {
    const gender = normalized(subjectGender);
    const male = ['nam', 'male', 'm'].includes(gender);
    const female = ['nu', 'female', 'f'].includes(gender);
    const gendered = (maleKey, femaleKey, neutralKey) => male ? maleKey : female ? femaleKey : neutralKey;
    if (key === 'wife') key = 'husband';
    else if (key === 'husband') key = 'wife';
    else if (['mother', 'father'].includes(key)) key = gendered('son', 'daughter', 'child');
    else if (['son', 'daughter'].includes(key)) key = gendered('father', 'mother', 'parent');
    else if (['older_brother', 'older_sister'].includes(key)) key = gendered('younger_brother', 'younger_sister', 'younger_sibling');
    else if (['younger_brother', 'younger_sister'].includes(key)) key = gendered('older_brother', 'older_sister', 'older_sibling');
    else if (key.includes('grandfather') || key.includes('grandmother')) key = gendered('grandson', 'granddaughter', 'grandchild');
    // A grandchild label does not identify the paternal/maternal branch.
    else if (['grandson', 'granddaughter'].includes(key)) key = gendered('grandfather', 'grandmother', 'grandparent');
  }
  return t('checkinCall.contact.' + key, lang);
}

function familyContact(row, recipientId, lang) {
  const name = String(row.subject_name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    || t('checkinCall.contact.name_unavailable', lang);
  const rawPhone = String(row.subject_phone || '').trim();
  const phone = /^\+?[0-9][0-9 ()-]{5,24}$/.test(rawPhone) ? rawPhone : null;
  return {
    name,
    relationship: relationshipForRecipient(row.relationship_type,
      Number(row.relationship_requester_id) === Number(recipientId), row.subject_gender, lang),
    phone_number: phone,
  };
}

function familyNotice(attempt, subject, lang) {
  const keys = NOTICE_KEYS[attempt.severity] || NOTICE_KEYS.UNKNOWN;
  const params = {
    name: subject.name,
    relationship: subject.relationship,
    // Read each digit, not the phone number as a large quantity.
    phone: subject.phone_number ? t('checkinCall.contact.audio_phone', lang, {
      phone: subject.phone_number.replace(/\d/g, '$& ').replace(/\s+/g, ' ').trim(),
    }) : t('checkinCall.contact.audio_phone_unavailable', lang),
    condition: attempt.triage_display?.summary
      ? t('checkinCall.contact.audio_condition', lang, { summary: attempt.triage_display.summary }) : '',
  };
  return {
    message: t(keys.message, lang, params),
    audio_text: t(keys.audio, lang, params).replace(/\s+/g, ' ').trim(),
  };
}

module.exports = { familyContact, familyNotice, relationshipForRecipient };
