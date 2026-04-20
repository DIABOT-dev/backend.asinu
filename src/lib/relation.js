/**
 * Map relationship_type (lưu trong user_connections) → cách gọi patient trong notification.
 *
 * `relationship_type` là vai trò của ADDRESSEE (caregiver) với REQUESTER (patient).
 * Ví dụ: requester là "con", khi mời bố/mẹ thì điền addressee='Bố' hoặc 'Mẹ'.
 * Khi notification gửi cho caregiver (Bố/Mẹ), họ phải biết patient là "con" của họ.
 *
 * Quy tắc: dùng nghịch đảo (reverse) — vì relationship_type lưu theo góc nhìn caregiver.
 *
 * @param {string} relType - Giá trị relationship_type lưu trong DB
 * @param {string} patientName - Tên patient (ví dụ "Hùng")
 * @param {string} lang - 'vi' hoặc 'en'
 * @returns {string} - Cách gọi patient cho caregiver, ví dụ "con trai Hùng"
 */
function getPatientRoleForCaregiver(relType, patientName, lang = 'vi', capitalize = false) {
  if (!relType) return patientName;
  if (lang === 'en') return patientName; // English giữ nguyên tên

  // Normalize (xóa dấu, viết thường)
  const r = String(relType).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Mapping: addressee (caregiver's role vs patient) → patient's role (in caregiver's view)
  const reverseMap = {
    'bo': 'con', 'me': 'con',
    'ong noi': 'cháu', 'ba noi': 'cháu', 'ong ngoai': 'cháu', 'ba ngoai': 'cháu',
    'anh trai': 'em', 'chi gai': 'em',
    'em trai': 'anh/chị', 'em gai': 'anh/chị',
    'vo': 'chồng', 'chong': 'vợ',
    'con trai': 'bố/mẹ', 'con gai': 'bố/mẹ',
    'ban than': 'bạn', 'nguoi yeu': 'người yêu',
  };

  const role = reverseMap[r];
  if (!role) return patientName;

  const displayRole = capitalize ? role.charAt(0).toUpperCase() + role.slice(1) : role;
  return `${displayRole} ${patientName}`;
}

module.exports = { getPatientRoleForCaregiver };
