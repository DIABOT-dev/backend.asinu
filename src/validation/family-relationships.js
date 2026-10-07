'use strict';

const vi = require('../i18n/locales/vi.json');
const en = require('../i18n/locales/en.json');

const FAMILY_RELATIONSHIPS = [
  { id: 'con-trai', labelKey: 'relSon', subtitleKey: 'relChild' },
  { id: 'con-gai', labelKey: 'relDaughter', subtitleKey: 'relChild' },
  { id: 'bo', labelKey: 'relFather', subtitleKey: 'relParent' },
  { id: 'me', labelKey: 'relMother', subtitleKey: 'relParent' },
  { id: 'vo', labelKey: 'relWife', subtitleKey: 'relSpouse' },
  { id: 'chong', labelKey: 'relHusband', subtitleKey: 'relSpouse' },
  { id: 'vo-chong', labelKey: 'relSpouseGeneric', subtitleKey: 'relSpouse' },
  { id: 'anh-trai', labelKey: 'relOlderBrother', subtitleKey: 'relSibling' },
  { id: 'chi-gai', labelKey: 'relOlderSister', subtitleKey: 'relSibling' },
  { id: 'em-trai', labelKey: 'relYoungerBrother', subtitleKey: 'relSibling' },
  { id: 'em-gai', labelKey: 'relYoungerSister', subtitleKey: 'relSibling' },
  { id: 'ong-noi', labelKey: 'relGrandfatherPaternal', subtitleKey: 'relGrandparentPaternal' },
  { id: 'ba-noi', labelKey: 'relGrandmotherPaternal', subtitleKey: 'relGrandparentPaternal' },
  { id: 'ong-ngoai', labelKey: 'relGrandfatherMaternal', subtitleKey: 'relGrandparentMaternal' },
  { id: 'ba-ngoai', labelKey: 'relGrandmotherMaternal', subtitleKey: 'relGrandparentMaternal' },
  { id: 'chau', labelKey: 'relGrandchild', subtitleKey: 'relGrandchildren' },
  { id: 'chau-trai', labelKey: 'relGrandson', subtitleKey: 'relGrandchildren' },
  { id: 'chau-gai', labelKey: 'relGranddaughter', subtitleKey: 'relGrandchildren' },
  { id: 'bac-trai', labelKey: 'relOlderUncle', subtitleKey: 'relUnclesAunts' },
  { id: 'bac-gai', labelKey: 'relOlderAunt', subtitleKey: 'relUnclesAunts' },
  { id: 'chu', labelKey: 'relPaternalUncle', subtitleKey: 'relUnclesAunts' },
  { id: 'co', labelKey: 'relPaternalAunt', subtitleKey: 'relUnclesAunts' },
  { id: 'cau', labelKey: 'relMaternalUncle', subtitleKey: 'relUnclesAunts' },
  { id: 'di', labelKey: 'relMaternalAunt', subtitleKey: 'relUnclesAunts' },
  { id: 'mo', labelKey: 'relUncleWifeMaternal', subtitleKey: 'relUnclesAunts' },
  { id: 'thim', labelKey: 'relUncleWifePaternal', subtitleKey: 'relUnclesAunts' },
  { id: 'duong', labelKey: 'relAuntHusband', subtitleKey: 'relUnclesAunts' },
  { id: 'chau-trai-goi-bang-co-chu', labelKey: 'relNephew', subtitleKey: 'relNephewsNieces' },
  { id: 'chau-gai-goi-bang-co-chu', labelKey: 'relNiece', subtitleKey: 'relNephewsNieces' },
  { id: 'anh-ho', labelKey: 'relOlderMaleCousin', subtitleKey: 'relCousins' },
  { id: 'chi-ho', labelKey: 'relOlderFemaleCousin', subtitleKey: 'relCousins' },
  { id: 'em-trai-ho', labelKey: 'relYoungerMaleCousin', subtitleKey: 'relCousins' },
  { id: 'em-gai-ho', labelKey: 'relYoungerFemaleCousin', subtitleKey: 'relCousins' },
  { id: 'bo-vo', labelKey: 'relWifeFather', subtitleKey: 'relInLaws' },
  { id: 'me-vo', labelKey: 'relWifeMother', subtitleKey: 'relInLaws' },
  { id: 'bo-chong', labelKey: 'relHusbandFather', subtitleKey: 'relInLaws' },
  { id: 'me-chong', labelKey: 'relHusbandMother', subtitleKey: 'relInLaws' },
  { id: 'con-dau', labelKey: 'relDaughterInLaw', subtitleKey: 'relInLaws' },
  { id: 'con-re', labelKey: 'relSonInLaw', subtitleKey: 'relInLaws' },
  { id: 'anh-re', labelKey: 'relOlderBrotherInLaw', subtitleKey: 'relInLaws' },
  { id: 'em-re', labelKey: 'relYoungerBrotherInLaw', subtitleKey: 'relInLaws' },
  { id: 'chi-dau', labelKey: 'relOlderSisterInLaw', subtitleKey: 'relInLaws' },
  { id: 'em-dau', labelKey: 'relYoungerSisterInLaw', subtitleKey: 'relInLaws' },
  { id: 'bo-duong', labelKey: 'relStepfather', subtitleKey: 'relStepAdoptive' },
  { id: 'me-ke', labelKey: 'relStepmother', subtitleKey: 'relStepAdoptive' },
  { id: 'bo-nuoi', labelKey: 'relAdoptiveFather', subtitleKey: 'relStepAdoptive' },
  { id: 'me-nuoi', labelKey: 'relAdoptiveMother', subtitleKey: 'relStepAdoptive' },
  { id: 'con-nuoi', labelKey: 'relAdoptedChild', subtitleKey: 'relStepAdoptive' },
  { id: 'cu-ong', labelKey: 'relGreatGrandfather', subtitleKey: 'relGreatGrandFamily' },
  { id: 'cu-ba', labelKey: 'relGreatGrandmother', subtitleKey: 'relGreatGrandFamily' },
  { id: 'chat', labelKey: 'relGreatGrandchild', subtitleKey: 'relGreatGrandFamily' },
  { id: 'ban-than', labelKey: 'relBestFriend', subtitleKey: 'relCloseFriend' },
  { id: 'nguoi-yeu', labelKey: 'relPartner', subtitleKey: 'relSoulmate' },
  { id: 'khac', labelKey: 'relOther', subtitleKey: 'relExtendedFamily' },
];
const REVERSE_LABELS = {
  'vo': ["relHusband","relHusband","relHusband"],
  'chong': ["relWife","relWife","relWife"],
  'vo-chong': ["relSpouseGeneric","relSpouseGeneric","relSpouseGeneric"],
  'bo': ["relSon","relDaughter","reverseChild"],
  'me': ["relSon","relDaughter","reverseChild"],
  'con-trai': ["relFather","relMother","reverseParent"],
  'con-gai': ["relFather","relMother","reverseParent"],
  'anh-trai': ["relYoungerBrother","relYoungerSister","reverseYoungerSibling"],
  'chi-gai': ["relYoungerBrother","relYoungerSister","reverseYoungerSibling"],
  'em-trai': ["relOlderBrother","relOlderSister","reverseOlderSibling"],
  'em-gai': ["relOlderBrother","relOlderSister","reverseOlderSibling"],
  'ong-noi': ["relGrandson","relGranddaughter","relGrandchild"],
  'ba-noi': ["relGrandson","relGranddaughter","relGrandchild"],
  'ong-ngoai': ["relGrandson","relGranddaughter","relGrandchild"],
  'ba-ngoai': ["relGrandson","relGranddaughter","relGrandchild"],
  'chau': ["relGrandfather","relGrandmother","relGrandparent"],
  'chau-trai': ["relGrandfather","relGrandmother","relGrandparent"],
  'chau-gai': ["relGrandfather","relGrandmother","relGrandparent"],
  'bac-trai': ["relNephew","relNiece","relNibling"],
  'bac-gai': ["relNephew","relNiece","relNibling"],
  'chu': ["relNephew","relNiece","relNibling"],
  'co': ["relNephew","relNiece","relNibling"],
  'cau': ["relNephew","relNiece","relNibling"],
  'di': ["relNephew","relNiece","relNibling"],
  'mo': ["relNephew","relNiece","relNibling"],
  'thim': ["relNephew","relNiece","relNibling"],
  'duong': ["relNephew","relNiece","relNibling"],
  'chau-trai-goi-bang-co-chu': ["relUncle","relAunt","roleRelative"],
  'chau-gai-goi-bang-co-chu': ["relUncle","relAunt","roleRelative"],
  'anh-ho': ["relYoungerMaleCousin","relYoungerFemaleCousin","relCousins"],
  'chi-ho': ["relYoungerMaleCousin","relYoungerFemaleCousin","relCousins"],
  'em-trai-ho': ["relOlderMaleCousin","relOlderFemaleCousin","relCousins"],
  'em-gai-ho': ["relOlderMaleCousin","relOlderFemaleCousin","relCousins"],
  'bo-vo': ["relSonInLaw","relDaughterInLaw","relFamilyInLaw"],
  'me-vo': ["relSonInLaw","relDaughterInLaw","relFamilyInLaw"],
  'bo-chong': ["relSonInLaw","relDaughterInLaw","relFamilyInLaw"],
  'me-chong': ["relSonInLaw","relDaughterInLaw","relFamilyInLaw"],
  'con-dau': ["relFamilyInLaw","relFamilyInLaw","relFamilyInLaw"],
  'con-re': ["relFamilyInLaw","relFamilyInLaw","relFamilyInLaw"],
  'anh-re': ["relFamilyInLaw","relFamilyInLaw","relFamilyInLaw"],
  'em-re': ["relFamilyInLaw","relFamilyInLaw","relFamilyInLaw"],
  'chi-dau': ["relFamilyInLaw","relFamilyInLaw","relFamilyInLaw"],
  'em-dau': ["relFamilyInLaw","relFamilyInLaw","relFamilyInLaw"],
  'bo-duong': ["relStepchild","relStepchild","relStepchild"],
  'me-ke': ["relStepchild","relStepchild","relStepchild"],
  'bo-nuoi': ["relAdoptedChild","relAdoptedChild","relAdoptedChild"],
  'me-nuoi': ["relAdoptedChild","relAdoptedChild","relAdoptedChild"],
  'con-nuoi': ["relAdoptiveFather","relAdoptiveMother","reverseParent"],
  'cu-ong': ["relGreatGrandchild","relGreatGrandchild","relGreatGrandchild"],
  'cu-ba': ["relGreatGrandchild","relGreatGrandchild","relGreatGrandchild"],
  'chat': ["relGreatGrandfather","relGreatGrandmother","relGreatGrandparent"],
};

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const aliases = new Map(FAMILY_RELATIONSHIPS.flatMap(option =>
  [option.id, vi['careCircle.relationship.' + option.labelKey], en['careCircle.relationship.' + option.labelKey]]
    .filter(Boolean).map(label => [normalize(label), option])
));
aliases.set(normalize('Ba'), aliases.get(normalize('bo')));
aliases.set(normalize('Cha'), aliases.get(normalize('bo')));
aliases.set(normalize('Close friend'), aliases.get(normalize('ban-than')));

function findFamilyRelationship(value) {
  return aliases.get(normalize(value));
}

function normalizeFamilyRelationship(value) {
  if (typeof value !== 'string') return value;
  const label = value.normalize('NFC').trim();
  return findFamilyRelationship(label)?.id || label;
}

function getReverseFamilyRelationshipKey(id, gender) {
  const inverse = REVERSE_LABELS[id];
  if (!inverse) return FAMILY_RELATIONSHIPS.find(option => option.id === id)?.labelKey || 'roleRelative';
  const normalizedGender = normalize(gender);
  const index = ['nam', 'male', 'm'].includes(normalizedGender) ? 0
    : ['nu', 'female', 'f'].includes(normalizedGender) ? 1 : 2;
  return inverse[index];
}

module.exports = { FAMILY_RELATIONSHIPS, findFamilyRelationship, normalizeFamilyRelationship, getReverseFamilyRelationshipKey };

