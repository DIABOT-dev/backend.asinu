'use strict';

// Re-evaluate saved responses after correcting a lab filter. Never calls AI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { evaluate } = require('./guardrails.cjs');
const { buildReport } = require('./report.cjs');
const out = path.resolve(__dirname, '../../../..', 'preview/checkin-conclusion-20261029');
const file = path.join(out, 'results.json');
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const guardrailsHash = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, 'guardrails.cjs')))
  .digest('hex');
for (const result of report.results) {
  if (!result.raw) continue;
  result.evaluation = evaluate(result.raw, report.fixture, result.promptId);
  if (result.returnedModel !== report.settings.model) {
    result.evaluation.passed = false;
    result.evaluation.rejected.push({
      event: 'conclusion_rejected',
      block: 'response',
      reason: 'provider_model_mismatch',
    });
  }
}
report.evaluation = {
  version: guardrailsHash,
  evaluatedAt: new Date().toISOString(),
  notes:
    'Re-evaluated the same 15 raw responses after regression-tested fixes for dates, nghỉ ngơi/có thể làm, and preventive lipid language. No additional provider calls.',
};
report.reviewNotes = [
  {
    promptId: 'P1',
    observation:
      'Ba lần đều khuyên đi khám nhưng không có phần giải thích và việc cần làm. Qua kiểm tra an toàn không đồng nghĩa đáp ứng bố cục mới.',
  },
  {
    promptId: 'P2',
    observation:
      'Giọng ấm, khá ổn định. Cả ba lần trích huyết áp 7 ngày, trái E2. Câu giữ mỡ máu ổn định khó hơn là nói về mục tiêu kiểm soát, không phải khẳng định kết quả xét nghiệm; bộ lọc đã tránh loại oan câu này.',
  },
  {
    promptId: 'P3',
    observation:
      'Lần 1 và 2 tự giải thích cơ thể làm việc nhiều hơn để xử lý mỡ thừa, không có căn cứ trong dữ liệu ca. Lần 2 và 3 nói ổn định so với lần trước dù chỉ có một số đo. Cần người có chuyên môn xem nội dung giải thích.',
  },
  {
    promptId: 'P4',
    observation:
      'Cả ba lần không tuân thủ tối đa 4 câu. Lần 1 và 2 vẫn trích chỉ số lịch sử; lần 1 tự so với lần trước. Lần 3 không trích số đo nên qua bộ kiểm tra thử, nhưng vẫn dài hơn yêu cầu biến thể.',
  },
  {
    promptId: 'P5',
    observation:
      'Cả ba lần phần liên quan chỉ 3 câu, không đạt yêu cầu 4–5 câu. Cả ba trích số đo lịch sử trái E2; hai lần đề xuất 4 việc. Không thấy lợi ích rõ của bản sâu trong ca cố định này.',
  },
];
fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
fs.writeFileSync(
  path.join(out, 'conclusion-rejected.jsonl'),
  report.results
    .flatMap((r) =>
      r.evaluation.rejected.map((e) => JSON.stringify({ promptId: r.promptId, run: r.run, ...e }))
    )
    .join('\n') + '\n'
);
buildReport(report, out);
console.log(
  JSON.stringify(
    report.prompts.map((p) => ({
      prompt: p.id,
      results: report.results
        .filter((r) => r.promptId === p.id)
        .map((r) => ({
          run: r.run,
          passed: r.evaluation.passed,
          reasons: r.evaluation.rejected.map((e) => e.reason),
          variantWarnings: r.evaluation.warnings.filter((e) => /P4_|P5_/.test(e.reason)),
        })),
    })),
    null,
    2
  )
);
