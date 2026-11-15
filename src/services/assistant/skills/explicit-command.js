'use strict';
const fold = text => text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/đ/gu, 'd');
// Only whole, explicit commands have a zero-model path. Anything outside these
// grammars (questions, another person, corrections, extra tasks) goes to AI.
function explicitCommand(request) {
  if (request.clarification) return null;
  const raw = request.text.normalize('NFC').trim().replace(/[.!]+$/u, '').trim();
  const text = fold(raw);
  const quantity = '(\\d+(?:[.,]\\d{1,3})?)';
  const unit = '(ml|mi li lit|mililit|milliliters?|millilitres?|l|lit|liters?|litres?)';
  const water = [
    new RegExp(`^(?:toi|minh) (?:vua |da )uong ${quantity} ${unit}(?: nuoc)?$`, 'u'),
    new RegExp(`^ghi(?: lai)? nuoc(?: uong)? ${quantity} ${unit}$`, 'u'),
    new RegExp(`^ghi(?: lai)? ${quantity} ${unit} nuoc$`, 'u'),
    new RegExp(`^i (?:just drank|drank) ${quantity} ${unit}(?: of water| water)?$`, 'u'),
  ].map(pattern => pattern.exec(text)).find(Boolean);
  if (water) return { type: 'water', volume_ml: Number(water[1].replace(',', '.')) * (/^(?:l|lit)/u.test(water[2]) ? 1000 : 1), evidence: request.text };

  const bp = /^(?:ghi(?: lai)? huyet ap|toi vua do huyet ap|huyet ap toi vua do(?: la)?) (\d{2,3})\s*\/\s*(\d{2,3})(?: mmhg)?(?:[, ]+nhip tim (\d{2,3})(?: nhip\/phut)?)?$/u.exec(text);
  if (bp) return { type: 'blood_pressure', systolic: Number(bp[1]), diastolic: Number(bp[2]), ...(bp[3] ? { pulse: Number(bp[3]) } : {}), evidence: request.text };

  const glucose = /^(?:ghi(?: lai)? duong huyet|toi vua do duong huyet|duong huyet toi vua do(?: la)?) (\d+(?:[.,]\d+)?)(?: mg\/dl)?(?: (luc doi|truoc bua an|sau bua an|truoc khi ngu))?$/u.exec(text);
  if (glucose) return { type: 'glucose', value: Number(glucose[1].replace(',', '.')), unit: 'mg/dL',
    ...(glucose[2] ? { context: { 'luc doi': 'fasting', 'truoc bua an': 'pre_meal', 'sau bua an': 'post_meal', 'truoc khi ngu': 'before_sleep' }[glucose[2]] } : {}), evidence: request.text };

  const medicine = [
    /^nhắc (?:tôi |mình )?uống ([A-Za-z][A-Za-z'-]{0,29}) (?:mỗi|hằng|hàng) ngày (?:lúc|vào) (.+)$/iu,
    /^nhắc (?:tôi |mình )?uống ([A-Za-z][A-Za-z'-]{0,29}) (?:lúc|vào) (.+) (?:mỗi|hằng|hàng) ngày$/iu,
  ].map(pattern => pattern.exec(raw)).find(Boolean);
  if (medicine && !/^(thuoc|medicine|medication|vitamin|supplement|insulin)$/iu.test(medicine[1])) {
    const times = medicine[2].split(/\s+và\s+|\s*,\s*/iu).map(explicitClock);
    if (times.length && times.length <= 4 && times.every(Boolean) && new Set(times).size === times.length)
      return { type: 'medication_create', name: medicine[1], times, evidence: request.text };
  }
  return null;
}

function explicitClock(value) {
  const text = fold(value.trim());
  const digital = /^(\d{1,2}):(\d{2})$/u.exec(text);
  if (digital) {
    const hour = Number(digital[1]), minute = Number(digital[2]);
    // Small unqualified hours can be a 12-hour clock: ask instead of guessing.
    return hour >= 13 && hour <= 23 && minute < 60 ? `${String(hour).padStart(2, '0')}:${digital[2]}` : null;
  }
  const match = /^(\d{1,2}) gio(?: (\d{1,2})(?: phut)?| (ruoi))? (sang|chieu|toi|trua)$/u.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[3] ? 30 : Number(match[2] || 0), period = match[4];
  if (minute > 59 || hour > 23) return null;
  if (period === 'sang') { if (hour >= 12) return null; }
  else if (period === 'trua') { if (hour !== 12) return null; }
  else if (hour >= 1 && hour < 12) hour += 12;
  else if (hour < 13) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

module.exports = { explicitCommand, explicitClock };
