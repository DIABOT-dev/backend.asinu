'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fields } = require('./guardrails.cjs');
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const disclaimer =
  'Lời khuyên của Asinu chỉ để tham khảo, không thay thế chẩn đoán và điều trị của bác sĩ. Kết nối với chuyên gia sức khoẻ của Asinu để nhận tư vấn sức khoẻ chính xác hơn.';
const titles = [
  'Lời nhắn cho anh',
  'Tình trạng này thường liên quan gì?',
  'Hôm nay anh nên làm',
  'Khi nào anh cần đi khám?',
];
const style = `
:root{color-scheme:light;--ink:oklch(27% .035 178);--muted:oklch(46% .02 178);--accent:oklch(41% .075 179);--paper:oklch(99% .003 178);--line:oklch(88% .015 178);--wash:oklch(96% .012 178)}
*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1440px;margin:auto;padding:36px}h1{font-size:32px;line-height:1.2;max-width:26ch}h2{font-size:23px;margin-top:36px}h3{font-size:19px;margin:0 0 12px}p{max-width:75ch}a{color:var(--accent)}.muted{color:var(--muted)}.notice{background:oklch(96% .04 85);padding:16px 20px;border:1px solid oklch(85% .04 85);border-radius:12px}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;background:var(--paper)}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:12px}th{font-size:14px;color:var(--muted)}td pre{white-space:pre-wrap;word-break:break-word;max-width:700px}pre{font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}details{margin:8px 0}summary{cursor:pointer;color:var(--accent)}.fail{color:oklch(39% .13 25)}.pass{color:var(--accent)}.pill{display:inline-block;border:1px solid var(--line);border-radius:8px;padding:2px 8px;font-size:14px}.review{background:var(--paper);padding:24px;border:1px solid var(--line);border-radius:16px;margin-bottom:28px}.review-grid{display:grid;grid-template-columns:440px minmax(0,1fr);gap:32px;align-items:start}.phone{background:var(--paper);max-width:430px;width:100%;margin:auto;border:1px solid var(--line);border-radius:24px;overflow:hidden}.phone-header{padding:24px 24px 16px;background:var(--wash);border-bottom:1px solid var(--line)}.phone-header strong{color:var(--accent);font-size:16px}.phone-header h2{margin:6px 0;font-size:26px}.phone-header small{color:var(--muted)}.screen-content{padding:6px 24px 24px}.block{padding:24px 0 0}.block h3{font-size:19px;color:var(--accent)}.block p,.block li{font-size:20px;line-height:1.65;margin:0}.block ul{margin:0;padding-left:22px}.block li+li{margin-top:10px}.disclaimer{background:oklch(96% .004 178);border-radius:12px;padding:16px;margin-top:24px;font-size:14px;color:var(--muted)}.followup{margin-top:22px;padding-top:20px;border-top:1px solid var(--line);font-size:18px}.cta{margin-top:20px;display:block;text-align:center;background:var(--accent);color:var(--paper);border-radius:12px;padding:16px;min-height:56px;font-size:18px}.absent{color:var(--muted);font-style:italic}.scores{display:grid;grid-template-columns:1fr 1fr;gap:16px}.scores label{display:grid;gap:4px;font-size:14px}select,input{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font:inherit;min-height:44px;padding:8px}input{margin-top:16px}select:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.mock-only{font-size:13px;padding:8px 24px;color:var(--muted);background:var(--wash)}.compact-list{padding-left:20px}.compact-list li{margin-bottom:8px}@media(max-width:850px){main{padding:20px}.review{padding:16px}.review-grid{grid-template-columns:1fr}.scores{grid-template-columns:1fr 1fr}h1{font-size:28px}}@media print{body{background:var(--paper)}main{padding:0}.review{break-before:page}details{display:block}.review-grid{grid-template-columns:430px 1fr}}`;

function blockValue(value) {
  if (Array.isArray(value) && value.length)
    return `<ul>${value.map((s) => `<li>${escape(s)}</li>`).join('')}</ul>`;
  return typeof value === 'string' && value.trim()
    ? `<p>${escape(value)}</p>`
    : '<p class="absent">Prompt này chưa tạo nội dung cho khối này.</p>';
}

function phone(result) {
  const parsed = result?.evaluation?.parsed || {};
  const data =
    result?.promptId === 'P1'
      ? {
          loi_nhan:
            'Asinu đã ghi nhận anh mệt mỏi, khó ngủ, ăn không ngon, đau nhức người và buồn bã vài ngày nay; tình trạng vẫn như cũ.',
          di_kham_khi: parsed.recommendation,
        }
      : parsed;
  return `<div class="phone" data-phone><header class="phone-header"><strong>Asinu</strong><h2>Lắng nghe sức khỏe hôm nay</h2><small>Bản thử bằng dữ liệu giả lập</small></header><div class="screen-content">${fields.map((f, i) => `<section class="block"><h3>${titles[i]}</h3>${blockValue(data[f])}</section>`).join('')}<div class="disclaimer">${escape(disclaimer)}</div><section class="followup"><strong>Hẹn hỏi lại</strong><br>Em sẽ hỏi lại anh sau 3 giờ nhé.</section><span class="cta">Kết nối với chuyên gia</span></div><div class="mock-only">Mô phỏng bố cục, chưa tích hợp vào app.</div></div>`;
}

function buildReport(report, out) {
  const results = report.results;
  const pass = results.filter((r) => r.evaluation.passed).length;
  const fast = results.filter((r) => r.within10Seconds).length;
  const tokens = results.reduce((s, r) => s + (r.usage?.total || 0), 0);
  const rows = report.prompts
    .map((p) => {
      const runs = results.filter((r) => r.promptId === p.id).sort((a, b) => a.run - b.run);
      return runs
        .map(
          (r) =>
            `<tr><td><strong>${p.id}</strong><br>Lần ${r.run}</td><td>${r.elapsedSeconds}s<br>${r.within10Seconds ? '≤ 10 giây' : '<span class="fail">&gt; 10 giây</span>'}</td><td>${r.usage?.prompt ?? 'N/A'} / ${r.usage?.completion ?? 'N/A'}<br>Tổng ${r.usage?.total ?? 'N/A'}</td><td class="${r.evaluation.passed ? 'pass' : 'fail'}">${r.evaluation.passed ? 'Qua kiểm tra tự động' : 'Bị loại'}<br><small>${r.evaluation.rejected.map((v) => `${escape(v.block)}: ${escape(v.reason)}`).join('<br>') || 'Không có lỗi từ bộ kiểm tra thử'}</small></td><td><details><summary>Nội dung trả về nguyên bản</summary><pre>${escape(r.raw || JSON.stringify(r.error))}</pre></details><details><summary>Cảnh báo cách viết (${r.evaluation.warnings.length})</summary><pre>${escape(JSON.stringify(r.evaluation.warnings, null, 2))}</pre></details></td></tr>`
        )
        .join('');
    })
    .join('');
  const observations = (report.reviewNotes || []).length
    ? `<h2>Nhận xét sau khi đọc đủ 15 phản hồi</h2><ul class="compact-list">${report.reviewNotes.map((n) => `<li><strong>${escape(n.promptId)}</strong>: ${escape(n.observation)}</li>`).join('')}</ul><p><strong>Đề xuất kỹ thuật:</strong> dùng P2 làm nền, sửa rõ quy tắc không nêu chỉ số 7 ngày khi 24 giờ chưa đo và không so sánh khi thiếu hai số đo. Nên thử lại bản sửa trước khi chốt prompt tích hợp. Chưa prompt mới nào đạt trọn các yêu cầu biến thể trong cả ba lần chạy.</p>`
    : '';
  const best = report.prompts
    .map((p) => {
      const runs = results.filter((r) => r.promptId === p.id && r.evaluation.parsed);
      const score = (r) =>
        r.evaluation.rejected.length * 100 +
        r.evaluation.warnings.length * 10 +
        r.elapsedSeconds / 100;
      const selected = [...runs].sort((a, b) => score(a) - score(b))[0];
      const rate = runs.filter((r) => r.evaluation.passed).length;
      const review = `<article id="${p.id}" class="review"><h2>${p.id}: ${escape(p.label)}</h2><p class="muted">${selected ? `Ảnh chọn lần ${selected.run}: ít lỗi tự động nhất, sau đó ít cảnh báo và phản hồi nhanh hơn. Đây không phải đánh giá y tế.` : 'Chưa có phản hồi hợp lệ để mô phỏng.'}</p><div class="review-grid">${phone(selected)}<div><h3>Kết quả ${rate}/${runs.length} phản hồi qua kiểm tra thử</h3><p>${p.id === 'P1' ? 'P1 dùng đúng prompt hiện tại: không nhận chỉ số hay lịch sử check-in. Lời nhắn trong ảnh là câu server mô phỏng; lời khuyên được đặt nguyên văn ở khối ④, chưa phân tách ②/③.' : 'Nội dung AI được hiển thị nguyên bản để duyệt, kể cả khi bị bộ lọc thử loại. Chưa áp dụng câu dự phòng để tránh che mất lỗi model.'}</p><p>${selected?.evaluation.passed ? 'Không phát hiện lỗi bằng bộ kiểm tra tự động thử nghiệm.' : `<span class="fail">${selected?.evaluation.rejected.map((v) => `${escape(v.block)}: ${escape(v.reason)}`).join('<br>') || 'Chưa có kết quả.'}</span>`}</p><h3>Founder chấm 1–5</h3><div class="scores">${['Hiểu mình', 'Có thông tin', 'An toàn', 'Dễ đọc'].map((label, i) => `<label>${label}<select data-save="${p.id}-${i}" aria-label="${label} cho ${p.id}"><option value="">Chưa chấm</option>${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join('')}</select></label>`).join('')}</div><label>Nhận xét<input data-save="${p.id}-notes" aria-label="Nhận xét ${p.id}"></label><p class="muted">Điểm chỉ lưu trong trình duyệt này, không tự ghi nhận Founder đã phê duyệt. Vui lòng trả lời prompt được chọn trong cuộc trao đổi.</p></div></div></article>`;
      const mock = `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${p.id} · Kết luận thử nghiệm</title><style>${style}body{background:var(--paper)}.phone{border:0;border-radius:0}</style>${phone(selected)}</html>`;
      fs.writeFileSync(path.join(out, `${p.id}.html`), mock);
      return review;
    })
    .join('');
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Asinu · Duyệt prompt kết luận check-in</title><style>${style}</style></head><body><main><p class="muted">SRS 29/10/2026 · Bước 0 · Dữ liệu giả lập</p><h1>Duyệt lời kết luận sau check-in</h1><p class="notice"><strong>Chờ Founder chọn prompt.</strong> Bộ luật mức độ, cấp cứu và kết luận đang chạy chưa thay đổi. Đây là bài thử prompt, chưa đủ điều kiện triển khai cho người dùng thật.</p><p>${results.length}/15 kết quả · ${pass} qua bộ kiểm tra tự động · ${fast} phản hồi trong 10 giây · ${tokens.toLocaleString('vi-VN')} token tổng (không phải số credits).</p><p>Model yêu cầu: <strong>medgemma-27b-it</strong>; temperature 0.2; tối đa 700 token cho mọi prompt để so sánh cùng cấu hình. Mỗi lần có thời hạn 60 giây để đo độ trễ thực tế, không dùng thời hạn này cho app. Không tự thử lại hoặc chuyển model. Endpoint: ${escape(report.endpoint)}.</p><p class="muted">P1 giữ nguyên prompt và system prompt lấy từ source hiện tại (${escape(report.sourceSha256.slice(0, 12))}), nhưng chạy cùng model/cấu hình đo như các bản mới. Production hiện dùng 250 token / 5 giây, nên bài này không tái hiện chính xác tỷ lệ timeout trên production.</p><nav>${report.prompts.map((p) => `<a href="#${p.id}">${p.id}</a>`).join(' · ')} · <a href="results.json">15 kết quả JSON</a> · <a href="results.csv">Bảng CSV</a> · <a href="prompts.json">Toàn bộ prompt</a></nav>${observations}<h2>Điểm cần chốt từ SRS</h2><ul class="compact-list"><li>FR-2/prompt cho phép so chỉ số 7 ngày, nhưng E2 cấm nêu số khi 24 giờ qua chưa đo. Bộ kiểm tra thử ưu tiên E2: nêu 128/82 lịch sử cũng bị ghi lỗi riêng để Founder xem xét.</li><li>P4 tối đa 4 câu được thử với một câu mỗi khối; số việc ít hơn bản đầy đủ là chủ ý của biến thể, không âm thầm sửa bản P2.</li><li>Lời cảnh báo gọi 115 có điều kiện được phân biệt với yêu cầu cấp cứu ngay không có dấu hiệu nguy hiểm. Từ “cấp cứu” vẫn được ghi cảnh báo AC-1.</li><li>Ca giả lập chỉ định anh/em ở tuổi 52. Luật xưng hô đang chạy dùng chú/cháu cho độ tuổi này; bài thử làm đúng ca cố định, chưa đổi luật xưng hô.</li><li>care_level=dat_lich_kham được lấy nguyên từ ca SRS, không khẳng định đây là đầu ra của calculateConclusion với ca này. Mốc 3 giờ trong ảnh là dữ liệu server mô phỏng để so bố cục, không do AI quyết định.</li><li>Từ điển bệnh và mẫu câu chỉ là bộ kiểm tra thử nghiệm, có thể bỏ sót và loại oan. Chưa có 30 ca nghiệm thu, chưa có người có chuyên môn y tế duyệt các con số hoặc P6 duyệt disclaimer.</li></ul><h2>Bảng 5 prompt × 3 lần</h2><div class="scroll"><table><thead><tr><th>Prompt / lần</th><th>Thời gian</th><th>Token vào / ra</th><th>Bộ lọc thử</th><th>Nội dung và cảnh báo</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Chưa chạy model.</td></tr>'}</tbody></table></div>${best}<h2>Phạm vi đã chuẩn bị</h2><p>Script thử độc lập, kiểm tra theo khối và ảnh mô phỏng. Chưa sửa generateConclusion, calculateConclusion, emergency templates, API hoặc màn app; không có migration hay deploy. Việc tích hợp chờ AC-0 theo tài liệu bạn cung cấp.</p><p>MedGemma cần được đánh giá theo từng trường hợp sử dụng trước khi triển khai: <a href="https://developers.google.com/health-ai-developer-foundations/medgemma">Google HAI-DEF</a>. Nguồn này không phải phê duyệt y tế cho nội dung kết quả.</p></main><script>for(const element of document.querySelectorAll('[data-save]')){const key='asinu-conclusion-review-'+element.dataset.save;try{element.value=localStorage.getItem(key)||''}catch{}element.addEventListener('change',()=>{try{localStorage.setItem(key,element.value)}catch{}})}</script></body></html>`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  const csv = [
    [
      'prompt',
      'run',
      'seconds',
      'within_10s',
      'returned_model',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'passed',
      'reasons',
      'raw',
    ],
    ...results.map((r) => [
      r.promptId,
      r.run,
      r.elapsedSeconds,
      r.within10Seconds,
      r.returnedModel,
      r.usage?.prompt,
      r.usage?.completion,
      r.usage?.total,
      r.evaluation.passed,
      JSON.stringify(r.evaluation.rejected),
      r.raw || JSON.stringify(r.error),
    ]),
  ];
  fs.writeFileSync(
    path.join(out, 'results.csv'),
    '\uFEFF' +
      csv
        .map((row) => row.map((c) => `"${String(c ?? '').replaceAll('"', '""')}"`).join(','))
        .join('\n')
  );
  fs.writeFileSync(
    path.join(out, 'founder-scorecard.csv'),
    '\uFEFFPrompt,Hiểu mình (1-5),Có thông tin (1-5),An toàn (1-5),Dễ đọc (1-5),Nhận xét\n' +
      report.prompts.map((p) => `${p.id},,,,,`).join('\n')
  );
}

module.exports = { buildReport };
