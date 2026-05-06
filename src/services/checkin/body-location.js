'use strict';

/**
 * Body Location → Symptoms mapping
 *
 * T2 Self Check-in: user chọn vùng cơ thể khó chịu, hệ thống filter list
 * triệu chứng T3 cho phù hợp. Cũng inject location vào AI prompt context để
 * câu hỏi triage tập trung.
 *
 * Mapping ưu tiên triệu chứng PHỔ BIẾN cho người 60+ Việt Nam, mỗi location
 * 5-7 items để dễ scan trên list mobile.
 *
 * Source: clinical guidelines for primary care + adapted for elderly Vietnamese.
 */

const BODY_LOCATIONS = [
  'head', 'chest', 'abdomen', 'limbs', 'skin', 'whole_body', 'mental',
];

const LOCATION_LABELS = {
  vi: {
    head:       { label: 'Đầu',          icon: '🧠', desc: 'Đau đầu, chóng mặt, hoa mắt' },
    chest:      { label: 'Ngực',         icon: '❤️',  desc: 'Khó thở, đau ngực, hồi hộp' },
    abdomen:    { label: 'Bụng',         icon: '🍽️',  desc: 'Đau bụng, buồn nôn, tiêu hoá' },
    limbs:      { label: 'Tay chân',     icon: '🦵', desc: 'Tê, đau khớp, yếu cơ' },
    skin:       { label: 'Da',           icon: '✋', desc: 'Ngứa, phát ban, vết bầm' },
    whole_body: { label: 'Toàn thân',    icon: '🌡️',  desc: 'Sốt, mệt mỏi, ớn lạnh' },
    mental:     { label: 'Tinh thần',    icon: '😴', desc: 'Lo âu, mất ngủ, buồn bã' },
  },
  en: {
    head:       { label: 'Head',         icon: '🧠', desc: 'Headache, dizziness, vision' },
    chest:      { label: 'Chest',        icon: '❤️',  desc: 'Breathing, chest pain, palpitations' },
    abdomen:    { label: 'Abdomen',      icon: '🍽️',  desc: 'Stomach pain, nausea, digestion' },
    limbs:      { label: 'Limbs',        icon: '🦵', desc: 'Numbness, joint pain, weakness' },
    skin:       { label: 'Skin',         icon: '✋', desc: 'Itching, rash, bruising' },
    whole_body: { label: 'Whole body',   icon: '🌡️',  desc: 'Fever, fatigue, chills' },
    mental:     { label: 'Mental',       icon: '😴', desc: 'Anxiety, insomnia, sadness' },
  },
};

const LOCATION_TO_SYMPTOMS = {
  vi: {
    head:       ['Đau đầu', 'Chóng mặt', 'Hoa mắt', 'Mờ mắt', 'Ù tai', 'Đau nửa đầu'],
    chest:      ['Khó thở', 'Đau ngực', 'Tức ngực', 'Hồi hộp', 'Tim đập nhanh', 'Vã mồ hôi'],
    abdomen:    ['Đau bụng', 'Buồn nôn', 'Tiêu chảy', 'Đầy hơi', 'Khó tiêu', 'Táo bón'],
    limbs:      ['Tê tay chân', 'Đau khớp', 'Yếu cơ', 'Chuột rút', 'Sưng khớp', 'Đau lưng'],
    skin:       ['Ngứa', 'Phát ban', 'Vàng da', 'Nóng rát', 'Vết bầm', 'Da khô'],
    whole_body: ['Sốt', 'Mệt mỏi', 'Ớn lạnh', 'Đau nhức toàn thân', 'Vã mồ hôi', 'Run rẩy'],
    mental:     ['Lo âu', 'Buồn bã', 'Khó ngủ', 'Mất ngủ', 'Căng thẳng', 'Mệt mỏi tinh thần'],
  },
  en: {
    head:       ['Headache', 'Dizziness', 'Light-headed', 'Blurred vision', 'Tinnitus', 'Migraine'],
    chest:      ['Shortness of breath', 'Chest pain', 'Chest tightness', 'Palpitations', 'Rapid heartbeat', 'Sweating'],
    abdomen:    ['Stomach pain', 'Nausea', 'Diarrhea', 'Bloating', 'Indigestion', 'Constipation'],
    limbs:      ['Numbness in limbs', 'Joint pain', 'Muscle weakness', 'Cramps', 'Swollen joints', 'Back pain'],
    skin:       ['Itching', 'Rash', 'Yellow skin', 'Burning', 'Bruises', 'Dry skin'],
    whole_body: ['Fever', 'Fatigue', 'Chills', 'Body aches', 'Sweating', 'Trembling'],
    mental:     ['Anxiety', 'Sadness', 'Trouble sleeping', 'Insomnia', 'Stress', 'Mental fatigue'],
  },
};

/**
 * Red-flag symptoms per location → escalate severity to 'emergency'
 * Match keywords trong user's free-text answer hoặc symptom list.
 *
 * Tiêu chí emergency: nguy cơ tử vong / di chứng vĩnh viễn nếu không cấp cứu trong vài phút.
 */
const EMERGENCY_KEYWORDS_BY_LOCATION = {
  head: [
    'đau đầu dữ dội', 'thunderclap', 'sét đánh',     // Sudden severe → SAH
    'yếu liệt nửa người', 'méo miệng', 'nói ngọng',   // Stroke FAST
    'mất thị lực', 'mất ý thức', 'co giật',
  ],
  chest: [
    'đau ngực dữ dội', 'đau ngực + khó thở', 'đau ngực lan',  // MI
    'khó thở dữ dội', 'tím tái', 'không nói được',             // Severe respiratory
    'ngất', 'tim đập rất nhanh + ngất',                        // Arrhythmia + syncope
  ],
  abdomen: [
    'đau bụng dữ dội', 'đau bụng + nôn ra máu',
    'đi ngoài ra máu', 'phân đen',                             // GI bleed
    'cứng bụng', 'đau bụng đột ngột',                          // Acute abdomen
  ],
  limbs: [
    'yếu liệt đột ngột', 'tê hoàn toàn nửa người',             // Stroke
    'sưng đau bắp chân + khó thở',                             // PE / DVT
  ],
  skin: [
    'mề đay + khó thở', 'phù mặt + khó thở',                   // Anaphylaxis
    'vàng da đột ngột', 'xuất huyết dưới da',                  // Acute liver / coag
  ],
  whole_body: [
    'sốt cao + cứng cổ', 'sốt + co giật',                      // Meningitis
    'lú lẫn + sốt', 'mất ý thức',
    'shock', 'sốc', 'huyết áp tụt',
  ],
  mental: [
    'muốn tự tử', 'tự sát', 'tự hại',                           // Suicide ideation
    'nghe tiếng nói', 'ảo giác cấp',                            // Acute psychosis
  ],
};

/**
 * Get localized labels for FE rendering.
 * @param {string} lang - 'vi' or 'en'
 * @returns {Array<{key, label, icon, desc}>}
 */
function getLocationOptions(lang = 'vi') {
  const labels = LOCATION_LABELS[lang] || LOCATION_LABELS.vi;
  return BODY_LOCATIONS.map(key => ({ key, ...labels[key] }));
}

/**
 * Get symptom suggestions for a location.
 * @param {string} location - one of BODY_LOCATIONS
 * @param {string} lang - 'vi' or 'en'
 * @returns {string[]}
 */
function getSymptomsForLocation(location, lang = 'vi') {
  const map = LOCATION_TO_SYMPTOMS[lang] || LOCATION_TO_SYMPTOMS.vi;
  return map[location] || [];
}

/**
 * Get merged + deduped symptom list for multiple locations.
 * Preserve ordering: locations[0] first, then locations[1], etc. Skip duplicates.
 *
 * @param {string[]} locations - array of body location keys
 * @param {string} lang - 'vi' or 'en'
 * @returns {string[]} - merged symptom list
 */
function getSymptomsForLocations(locations, lang = 'vi') {
  if (!Array.isArray(locations) || locations.length === 0) return [];
  const seen = new Set();
  const merged = [];
  for (const loc of locations) {
    const symptoms = getSymptomsForLocation(loc, lang);
    for (const s of symptoms) {
      const k = s.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(s);
      }
    }
  }
  return merged;
}

/**
 * Build AI prompt context for location(s).
 * Single → "Vùng khó chịu: Đầu"
 * Multi  → "Vùng khó chịu: Đầu, Ngực, Bụng — hỏi cross-correlation"
 * Many   → "Khó chịu nhiều vùng (N=5) — hỏi systemic / toàn thân"
 * Plus other free-text nếu có.
 *
 * @param {string[]} locations
 * @param {string|null} other - free-text từ user
 * @param {string} lang
 */
function buildLocationContext(locations = [], other = null, lang = 'vi') {
  const labels = (LOCATION_LABELS[lang] || LOCATION_LABELS.vi);
  const named = (locations || []).map(l => labels[l]?.label || l).filter(Boolean);
  const parts = [];
  if (named.length === 0) parts.push('Chưa rõ vùng khó chịu');
  else if (named.length === 1) parts.push(`Vùng khó chịu: ${named[0]}`);
  else if (named.length <= 3) parts.push(`Vùng khó chịu: ${named.join(', ')} → hỏi cross-correlation giữa các vùng.`);
  else parts.push(`Khó chịu nhiều vùng (${named.length}: ${named.join(', ')}) → hỏi systemic + assess toàn thân.`);
  if (other && other.trim()) parts.push(`User mô tả thêm: "${other.trim()}".`);
  return parts.join(' ');
}

/**
 * Detect if any answer text matches emergency keywords for the given location.
 * @param {string} location
 * @param {string} answerText - free-text or joined options
 * @returns {{ isEmergency: boolean, matchedKeyword: string|null }}
 */
function detectEmergency(location, answerText) {
  if (!answerText || typeof answerText !== 'string') return { isEmergency: false, matchedKeyword: null };
  const lower = answerText.toLowerCase();
  const keywords = EMERGENCY_KEYWORDS_BY_LOCATION[location] || [];
  // Also check generic emergency keywords across all locations
  const allEmergency = Object.values(EMERGENCY_KEYWORDS_BY_LOCATION).flat();

  for (const kw of [...keywords, ...allEmergency]) {
    if (lower.includes(kw.toLowerCase())) {
      return { isEmergency: true, matchedKeyword: kw };
    }
  }
  return { isEmergency: false, matchedKeyword: null };
}

/**
 * Localize a body_location key for use in AI prompts (Vietnamese only — AI
 * prompts run in VN).
 */
function localizeForPrompt(location) {
  return LOCATION_LABELS.vi[location]?.label || location;
}

/**
 * Get symptom options GROUPED theo location — UX rõ ràng hơn flat list.
 * Mỗi group: { key, label, icon, items[] }.
 *
 * @param {string[]} locations
 * @param {string} lang
 * @returns {Array<{ key: string, label: string, icon: string, items: string[] }>}
 */
function getGroupedSymptoms(locations, lang = 'vi') {
  if (!Array.isArray(locations) || locations.length === 0) return [];
  const labels = LOCATION_LABELS[lang] || LOCATION_LABELS.vi;
  return locations
    .map(loc => {
      const meta = labels[loc];
      if (!meta) return null;
      const items = getSymptomsForLocation(loc, lang);
      if (items.length === 0) return null;
      return {
        key: loc,
        label: meta.label,
        icon: meta.icon,  // emoji ở backend (FE map sang vector icon)
        items,
      };
    })
    .filter(Boolean);
}

module.exports = {
  BODY_LOCATIONS,
  LOCATION_LABELS,
  LOCATION_TO_SYMPTOMS,
  EMERGENCY_KEYWORDS_BY_LOCATION,
  getLocationOptions,
  getSymptomsForLocation,
  getSymptomsForLocations,
  getGroupedSymptoms,
  buildLocationContext,
  detectEmergency,
  localizeForPrompt,
};
