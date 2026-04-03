'use strict';

// ---------------------------------------------------------------------------
// Emergency Detector — pure logic, zero AI calls
// Detects life-threatening emergencies from Vietnamese symptom text.
// ---------------------------------------------------------------------------

const CURRENT_YEAR = new Date().getFullYear();

// ---- helpers --------------------------------------------------------------

/**
 * Return true when *any* pattern in `patterns` is found inside `text`.
 * Ignores matches preceded by negation words (không, khong, chưa, chua, hết, het, bớt, bot).
 */
function matchesAny(text, patterns) {
  const negations = ['không ', 'khong ', 'chưa ', 'chua ', 'hết ', 'het ', 'bớt ', 'bot ', 'không bị ', 'khong bi ', 'không có ', 'khong co '];
  return patterns.some((p) => {
    const idx = text.indexOf(p);
    if (idx === -1) return false;
    // Check if preceded by negation
    const before = text.substring(Math.max(0, idx - 12), idx);
    return !negations.some(neg => before.endsWith(neg));
  });
}

/**
 * Return true when *all* groups have at least one matching pattern in `text`.
 * Each group is an array of alternative keywords.
 */
function matchesAll(text, groups) {
  return groups.every((group) => matchesAny(text, group));
}

// ---- keyword dictionaries -------------------------------------------------

const STROKE_KW = [
  'yếu nửa người', 'yeu nua nguoi',
  'tê nửa người', 'te nua nguoi',
  'liệt nửa người', 'liet nua nguoi',
  'nói ngọng', 'noi ngong',
  'khó nói', 'kho noi',
  'nói khó', 'noi kho',
  'nói lắp đột ngột', 'noi lap dot ngot',
  'méo miệng', 'meo mieng',
  'méo mặt', 'meo mat',
  'mất thị lực đột ngột', 'mat thi luc dot ngot',
  'mờ mắt đột ngột', 'mo mat dot ngot',
  'mù đột ngột', 'mu dot ngot',
  'đột quỵ', 'dot quy',
  'tai biến', 'tai bien',
  'tay chân yếu một bên', 'tay chan yeu mot ben',
  'không nhấc được tay', 'khong nhac duoc tay',
  'không cử động được nửa người',
];

const CHEST_PAIN_KW = [
  'đau ngực', 'dau nguc',
  'tức ngực', 'tuc nguc',
  'nặng ngực', 'nang nguc',
  'đè ngực', 'de nguc',
  'bóp ngực', 'bop nguc',
  'đau thắt ngực', 'dau that nguc',
  'nhói ngực', 'nhoi nguc',
];

const MI_COMPANION_KW = [
  'khó thở', 'kho tho',
  'vã mồ hôi', 'va mo hoi',
  'đổ mồ hôi lạnh', 'do mo hoi lanh',
  'mồ hôi lạnh', 'mo hoi lanh',
  'buồn nôn', 'buon non',
  'nôn', 'non',
  'đau lan tay', 'dau lan tay',
  'đau lan cánh tay', 'dau lan canh tay',
  'đau lan hàm', 'dau lan ham',
  'đau lan vai', 'dau lan vai',
  'đau lan lưng', 'dau lan lung',
  'choáng váng', 'choang vang',
  'ngất', 'ngat',
  'xỉu', 'xiu',
  'hoa mắt', 'hoa mat',
];

const FEVER_KW = [
  'sốt', 'sot',
  'sốt cao', 'sot cao',
  'nóng người', 'nong nguoi',
  'nóng sốt', 'nong sot',
  'nhiệt độ cao',
];

const NECK_STIFFNESS_KW = [
  'cứng cổ', 'cung co',
  'cứng gáy', 'cung gay',
  'gáy cứng', 'gay cung',
  'cổ cứng', 'co cung',
  'không quay được cổ',
  'đau gáy cứng',
];

const SUDDEN_DYSPNEA_KW = [
  'khó thở đột ngột', 'kho tho dot ngot',
  'đột ngột khó thở', 'dot ngot kho tho',
  'tự nhiên khó thở', 'tu nhien kho tho',
  'bỗng dưng khó thở', 'bong dung kho tho',
  'thở không được đột ngột',
  'hụt hơi đột ngột',
];

const PE_COMPANION_KW = [
  'đau ngực', 'dau nguc',
  'tức ngực', 'tuc nguc',
  'sưng chân', 'sung chan',
  'phù chân', 'phu chan',
  'chân sưng', 'chan sung',
  'chân phù', 'chan phu',
  'đau bắp chân', 'dau bap chan',
  'ho ra máu', 'ho ra mau',
];

const BACK_PAIN_KW = [
  'đau lưng', 'dau lung',
  'đau cột sống', 'dau cot song',
  'đau thắt lưng', 'dau that lung',
];

const CAUDA_COMPANION_KW = [
  'mất kiểm soát tiểu', 'mat kiem soat tieu',
  'mất kiểm soát tiểu tiện',
  'tiểu không kiểm soát',
  'không kiểm soát được tiểu',
  'mất kiểm soát đại tiện',
  'đại tiện không kiểm soát',
  'tê vùng bẹn', 'te vung ben',
  'tê bẹn', 'te ben',
  'tê vùng đáy chậu', 'te vung day chau',
  'tê hậu môn', 'te hau mon',
  'yếu hai chân', 'yeu hai chan',
  'liệt hai chân', 'liet hai chan',
  'không đi được', 'khong di duoc',
  'tê hai chân', 'te hai chan',
];

const HEMORRHAGE_DIRECT_KW = [
  'nôn ra máu', 'non ra mau',
  'ói ra máu', 'oi ra mau',
  'phân đen', 'phan den',
  'đi ngoài phân đen',
  'đại tiện ra máu', 'dai tien ra mau',
  'đi cầu ra máu', 'di cau ra mau',
  'tiêu ra máu', 'tieu ra mau',
  'chảy máu trực tràng',
];

const SEVERE_ABDOMINAL_KW = [
  'đau bụng dữ dội', 'dau bung du doi',
  'đau bụng rất nhiều',
  'đau bụng không chịu được',
  'đau bụng quằn quại',
  'đau bụng kinh khủng',
];

const SYNCOPE_KW = [
  'ngất', 'ngat',
  'xỉu', 'xiu',
  'bất tỉnh', 'bat tinh',
  'mất ý thức', 'mat y thuc',
  'hôn mê', 'hon me',
];

const DYSPNEA_KW = [
  'khó thở', 'kho tho',
  'thở khó', 'tho kho',
  'hụt hơi', 'hut hoi',
  'thở không nổi',
  'thở gấp', 'tho gap',
  'ngạt thở', 'ngat tho',
  'không thở được',
];

const ANGIOEDEMA_KW = [
  'sưng mặt', 'sung mat',
  'phù mặt', 'phu mat',
  'sưng lưỡi', 'sung luoi',
  'phù lưỡi', 'phu luoi',
  'sưng môi', 'sung moi',
  'phù môi', 'phu moi',
  'sưng mắt', 'sung mat',
  'sưng họng', 'sung hong',
  'phù họng',
  'phát ban toàn thân', 'phat ban toan than',
  'nổi mề đay toàn thân', 'noi me day toan than',
  'mẩn đỏ khắp người',
  'nổi mẩn khắp người',
  'mề đay khắp người',
];

const DENGUE_BLEED_KW = [
  'chảy máu bất thường', 'chay mau bat thuong',
  'xuất huyết', 'xuat huyet',
  'chấm đỏ dưới da', 'cham do duoi da',
  'xuất huyết dưới da', 'xuat huyet duoi da',
  'bầm tím', 'bam tim',
  'chảy máu chân răng', 'chay mau chan rang',
  'chảy máu mũi', 'chay mau mui',
  'chảy máu nướu', 'chay mau nuou',
  'petechiae',
];

const ABDOMINAL_PAIN_KW = [
  'đau bụng', 'dau bung',
  'đau dạ dày', 'dau da day',
  'đau vùng bụng',
];

const EXCESSIVE_THIRST_KW = [
  'khát nước nhiều', 'khat nuoc nhieu',
  'uống nước nhiều', 'uong nuoc nhieu',
  'khát nhiều', 'khat nhieu',
  'khát nước liên tục',
  'khát dữ dội',
  'tiểu nhiều', 'tieu nhieu',
];

const DKA_COMPANION_KW = [
  'buồn nôn', 'buon non',
  'nôn', 'non',
  'ói', 'oi',
  'thở nhanh', 'tho nhanh',
  'thở gấp', 'tho gap',
  'thở sâu', 'tho sau',
  'mệt lả', 'met la',
  'mệt mỏi nhiều', 'met moi nhieu',
  'kiệt sức', 'kiet suc',
  'lơ mơ', 'lo mo',
  'lừ đừ', 'lu du',
  'đau bụng', 'dau bung',
  'hơi thở có mùi trái cây',
];

const SEIZURE_KW = [
  'co giật', 'co giat',
  'động kinh', 'dong kinh',
  'giật mình liên tục',
  'lên cơn co giật',
  'lên cơn động kinh',
  'sùi bọt mép', 'sui bot mep',
  'cắn lưỡi', 'can luoi',
  'mắt trợn', 'mat tron',
  'co cứng toàn thân',
];

// ---- Comprehensive red-flag keyword list ----------------------------------

const RED_FLAG_KEYWORDS = [
  // stroke
  'yếu nửa người', 'tê nửa người', 'liệt nửa người',
  'nói ngọng', 'khó nói', 'méo miệng', 'méo mặt',
  'mất thị lực đột ngột', 'đột quỵ', 'tai biến',
  // cardiac
  'đau ngực', 'tức ngực', 'đau thắt ngực',
  'đau lan tay', 'đau lan hàm',
  // meningitis
  'cứng cổ', 'cứng gáy',
  // breathing
  'khó thở đột ngột', 'ngạt thở', 'không thở được',
  // hemorrhage
  'nôn ra máu', 'ói ra máu', 'phân đen',
  'đại tiện ra máu', 'tiêu ra máu', 'ho ra máu',
  // shock / syncope
  'ngất', 'xỉu', 'bất tỉnh', 'mất ý thức', 'hôn mê',
  // anaphylaxis
  'sưng lưỡi', 'sưng họng', 'phù họng', 'phù lưỡi',
  'phát ban toàn thân',
  // dengue hemorrhagic
  'xuất huyết', 'chảy máu bất thường', 'chấm đỏ dưới da',
  // seizure
  'co giật', 'động kinh', 'sùi bọt mép',
  // cauda equina
  'mất kiểm soát tiểu', 'tê vùng bẹn',
  'liệt hai chân', 'yếu hai chân',
  // severe pain
  'đau bụng dữ dội', 'đau dữ dội', 'đau không chịu được',
  // consciousness
  'lơ mơ', 'lừ đừ', 'không đáp ứng',
  'gọi không tỉnh', 'li bì',
  // other critical
  'tím tái', 'tím môi', 'da xanh tái',
  'mạch yếu', 'huyết áp tụt',
  'sốt cao co giật',
  'đau đầu dữ dội đột ngột',
  'cổ cứng',
  'sưng mặt', 'phù mặt',
  'co cứng toàn thân',
];

// ---- emergency result builder ---------------------------------------------

function result(isEmergency, type, severity, needsDoctor, needsFamilyAlert, followUpHours) {
  return {
    isEmergency,
    type,
    severity,
    needsDoctor,
    needsFamilyAlert,
    followUpHours,
  };
}

const SAFE = result(false, null, 'low', false, false, 72);

// ---- main detector --------------------------------------------------------

/**
 * Detect life-threatening emergencies from symptom text combinations.
 *
 * @param {string[]} symptoms          — all symptoms reported (Vietnamese text)
 * @param {Object}   profile           — { birth_year, gender, medical_conditions }
 * @returns {{
 *   isEmergency: boolean,
 *   type: string|null,
 *   severity: string,
 *   needsDoctor: boolean,
 *   needsFamilyAlert: boolean,
 *   followUpHours: number
 * }}
 */
function detectEmergency(symptoms, profile = {}) {
  if (!symptoms || symptoms.length === 0) return SAFE;

  const text = symptoms.join(' ').toLowerCase();
  const age = profile.birth_year ? CURRENT_YEAR - profile.birth_year : null;
  const conditions = (profile.medical_conditions || []).join(' ').toLowerCase();

  const hasHeart =
    conditions.includes('tim') ||
    conditions.includes('heart') ||
    conditions.includes('bệnh tim') ||
    conditions.includes('benh tim') ||
    conditions.includes('suy tim') ||
    conditions.includes('tim mach');
  const hasHTN =
    conditions.includes('huyết áp') ||
    conditions.includes('huyet ap') ||
    conditions.includes('hypertension') ||
    conditions.includes('cao huyết áp') ||
    conditions.includes('cao huyet ap') ||
    conditions.includes('tăng huyết áp') ||
    conditions.includes('tang huyet ap');
  const hasDM =
    conditions.includes('tiểu đường') ||
    conditions.includes('tieu duong') ||
    conditions.includes('diabetes') ||
    conditions.includes('đái tháo đường') ||
    conditions.includes('dai thao duong') ||
    conditions.includes('đường huyết') ||
    conditions.includes('duong huyet');

  // 1. STROKE — any single keyword is enough
  if (matchesAny(text, STROKE_KW)) {
    const highRisk = (age !== null && age > 50) || hasHTN || hasHeart;
    return result(
      true,
      'STROKE',
      'critical',
      true,
      true,
      0, // immediate
    );
  }

  // 2. MI (myocardial infarction) — chest pain + companion symptom
  if (matchesAny(text, CHEST_PAIN_KW) && matchesAny(text, MI_COMPANION_KW)) {
    return result(true, 'MI', 'critical', true, true, 0);
  }

  // 3. MENINGITIS — fever + neck stiffness
  if (matchesAny(text, FEVER_KW) && matchesAny(text, NECK_STIFFNESS_KW)) {
    return result(true, 'MENINGITIS', 'critical', true, true, 0);
  }

  // 4. PE (pulmonary embolism) — sudden dyspnea + companion
  if (matchesAny(text, SUDDEN_DYSPNEA_KW) && matchesAny(text, PE_COMPANION_KW)) {
    return result(true, 'PE', 'critical', true, true, 0);
  }

  // 5. CAUDA EQUINA — back pain + neurological deficit
  if (matchesAny(text, BACK_PAIN_KW) && matchesAny(text, CAUDA_COMPANION_KW)) {
    return result(true, 'CAUDA_EQUINA', 'critical', true, true, 0);
  }

  // 6. INTERNAL HEMORRHAGE
  //    a) direct bleeding signs (vomiting blood, black stool)
  //    b) severe abdominal pain + syncope
  if (matchesAny(text, HEMORRHAGE_DIRECT_KW)) {
    return result(true, 'INTERNAL_HEMORRHAGE', 'critical', true, true, 0);
  }
  if (matchesAny(text, SEVERE_ABDOMINAL_KW) && matchesAny(text, SYNCOPE_KW)) {
    return result(true, 'INTERNAL_HEMORRHAGE', 'critical', true, true, 0);
  }

  // 7. ANAPHYLAXIS — dyspnea + angioedema / systemic rash
  if (matchesAny(text, DYSPNEA_KW) && matchesAny(text, ANGIOEDEMA_KW)) {
    return result(true, 'ANAPHYLAXIS', 'critical', true, true, 0);
  }

  // 8. DENGUE HEMORRHAGIC — fever + bleeding signs + abdominal pain
  if (
    matchesAny(text, FEVER_KW) &&
    matchesAny(text, DENGUE_BLEED_KW) &&
    matchesAny(text, ABDOMINAL_PAIN_KW)
  ) {
    return result(true, 'DENGUE_HEMORRHAGIC', 'critical', true, true, 0);
  }

  // 9. DKA (diabetic ketoacidosis) — diabetes + excessive thirst + companion
  if (hasDM && matchesAny(text, EXCESSIVE_THIRST_KW) && matchesAny(text, DKA_COMPANION_KW)) {
    return result(true, 'DKA', 'critical', true, true, 0);
  }

  // 10. SEIZURE — any seizure keyword (critical — active seizure is life-threatening)
  if (matchesAny(text, SEIZURE_KW)) {
    return result(true, 'SEIZURE', 'critical', true, true, 0);
  }

  // ---- Sub-critical but still concerning combinations ---------------------

  // Isolated chest pain in cardiac-risk patient
  if (matchesAny(text, CHEST_PAIN_KW) && (hasHeart || hasHTN || (age !== null && age > 55))) {
    return result(false, 'CHEST_PAIN_HIGH_RISK', 'high', true, true, 2);
  }

  // Isolated chest pain, no risk factors
  if (matchesAny(text, CHEST_PAIN_KW)) {
    return result(false, 'CHEST_PAIN', 'moderate', true, false, 6);
  }

  // Fever + altered consciousness
  if (matchesAny(text, FEVER_KW) && matchesAny(text, SYNCOPE_KW)) {
    return result(false, 'FEVER_SYNCOPE', 'high', true, true, 2);
  }

  // Severe headache (sudden onset) — possible SAH
  const sahKw = [
    'đau đầu dữ dội đột ngột', 'dau dau du doi dot ngot',
    'đau đầu kinh khủng', 'đau đầu như búa bổ',
    'đau đầu dữ dội nhất từ trước đến nay',
    'đau đầu chưa từng có',
  ];
  if (matchesAny(text, sahKw)) {
    return result(false, 'POSSIBLE_SAH', 'high', true, true, 1);
  }

  // Difficulty breathing alone (not sudden onset) in elderly or cardiac patient
  if (matchesAny(text, DYSPNEA_KW) && (hasHeart || (age !== null && age > 65))) {
    return result(false, 'DYSPNEA_HIGH_RISK', 'high', true, false, 4);
  }

  // High fever in elderly
  if (matchesAny(text, FEVER_KW) && age !== null && age > 70) {
    return result(false, 'FEVER_ELDERLY', 'moderate', true, false, 6);
  }

  return SAFE;
}

// ---- red-flag checker -----------------------------------------------------

/**
 * Quick check whether a single text string contains ANY known red flag.
 *
 * @param {string} symptomText — free-form Vietnamese text
 * @returns {boolean}
 */
/**
 * Check if a keyword match is negated (preceded by "không", "chưa", etc.)
 */
function isNegated(text, keyword) {
  const idx = text.indexOf(keyword);
  if (idx === -1) return true; // not found = "negated"
  const negations = ['không ', 'khong ', 'chưa ', 'chua ', 'hết ', 'het ', 'bớt ', 'bot ', 'không bị ', 'khong bi ', 'không có ', 'khong co '];
  const before = text.substring(Math.max(0, idx - 12), idx);
  return negations.some(neg => before.endsWith(neg));
}

function isRedFlag(symptomText) {
  if (!symptomText) return false;
  const lower = symptomText.toLowerCase();
  return RED_FLAG_KEYWORDS.some((kw) => lower.includes(kw) && !isNegated(lower, kw));
}

/**
 * Return all matched red-flag keywords found in the text (negation-aware).
 *
 * @param {string} symptomText
 * @returns {string[]}
 */
function getRedFlags(symptomText) {
  if (!symptomText) return [];
  const lower = symptomText.toLowerCase();
  return RED_FLAG_KEYWORDS.filter((kw) => lower.includes(kw) && !isNegated(lower, kw));
}

// ---- exports --------------------------------------------------------------

module.exports = {
  detectEmergency,
  isRedFlag,
  getRedFlags,
};
