'use strict';

// Offline lab only. Nothing under src imports this directory.
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./fixture.json');
const baseline = require('./baseline.json');
const root = path.resolve(__dirname, '../..');
const sourceSha256 = baseline.sourceSha256;
const h = { honorific: fixture.xung_ho.goi, selfRef: fixture.xung_ho.tu_xung };
const p2 = fs
  .readFileSync(path.join(__dirname, 'p2.txt'), 'utf8')
  .replaceAll('{goi}', h.honorific)
  .replaceAll('{tu_xung}', h.selfRef)
  .replace('{JSON theo FR-2}', JSON.stringify(fixture));
const p3 = p2.slice(0, p2.indexOf('VÍ DỤ')).trim();
const prompts = [
  { id: baseline.id, label: baseline.label, system: baseline.system, prompt: baseline.prompt },
  { id: 'P2', label: 'Đầy đủ, có ví dụ', prompt: p2 },
  { id: 'P3', label: 'Đầy đủ, không ví dụ', prompt: p3 },
  {
    id: 'P4',
    label: 'Ngắn, tối đa 4 câu',
    prompt: p2.replace(
      'NỘI DUNG',
      'BẢN NGẮN: Toàn bộ bốn trường nội dung tối đa 4 câu. Mỗi khối một câu; các mảng vẫn là mảng, có thể chỉ một phần tử. Ưu tiên ngắn gọn khi khác giới hạn số câu/việc ở dưới.\n\nNỘI DUNG'
    ),
  },
  {
    id: 'P5',
    label: 'Giải thích sâu 4–5 câu',
    prompt: p2.replace(
      '2. lien_quan: giải thích',
      '2. lien_quan: viết 4–5 câu, giải thích kỹ hơn bằng lời thường, không suy đoán nguyên nhân cá nhân. Cụ thể: giải thích'
    ),
  },
];

module.exports = {
  fixture,
  prompts,
  root,
  sourceSha256,
};
