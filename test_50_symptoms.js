require('dotenv').config();
const jwt = require('jsonwebtoken');
const TOKEN = jwt.sign({ id: 4 }, process.env.JWT_SECRET, { expiresIn: '1d' });

async function api(path, body) {
  const r = await fetch('http://localhost:3000/api/mobile' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify(body),
  });
  return r.json();
}

const inputs = [
  // 1-10: Có dấu chuẩn
  "đau đầu", "đau bụng", "chóng mặt", "mệt mỏi", "ho",
  "sốt", "đau lưng", "đau khớp", "mất ngủ", "buồn nôn",
  // 11-20: Không dấu
  "dau dau", "dau bung", "chong mat", "met moi", "kho tho",
  "buon non", "te tay", "dau nguc", "tieu chay", "dau hong",
  // 21-30: Tiếng lóng
  "mệt vãi", "đau quá trời", "nhức đầu kinh", "bụng đau điên", "ho sặc sụa",
  "ói mửa hoài", "xỉu luôn", "thở ko nổi", "ngứa điên", "tê rần rần",
  // 31-40: Câu dài
  "sáng dậy đau đầu chóng mặt hoa mắt",
  "mấy hôm nay bụng đau ăn không được",
  "đêm qua ho suốt không ngủ được",
  "hai ngày nay sốt cao uống thuốc không hạ",
  "tay trái tê bì cầm đồ hay rớt",
  "đau lưng dưới ngồi lâu không chịu nổi",
  "mắt phải mờ từ sáng nhìn không rõ",
  "chân sưng đi lại khó khăn",
  "ợ nóng sau ăn khó chịu lắm",
  "nổi mẩn đỏ ngứa khắp người",
  // 41-45: Emergency
  "đau ngực khó thở", "yếu nửa người nói ngọng", "co giật", "nôn ra máu", "sốt cao cứng cổ",
  // 46-50: Edge
  "", "   ", "asdfghjkl", "12345", "😫😫😫",
];

const categories = [
  ...Array(10).fill("co_dau"),
  ...Array(10).fill("khong_dau"),
  ...Array(10).fill("tieng_long"),
  ...Array(10).fill("cau_dai"),
  ...Array(5).fill("emergency"),
  ...Array(5).fill("edge"),
];

async function runTest(index, symptom) {
  const start = Date.now();
  let result;
  try {
    result = await api('/checkin/script/start', {
      status: 'tired',
      symptom_input: symptom,
    });
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    return {
      index: index + 1,
      input: symptom,
      category: categories[index],
      error: err.message,
      time: parseFloat(elapsed),
      pass: false,
      reason: 'CRASH: ' + err.message,
    };
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  const time = parseFloat(elapsed);

  // Check criteria
  const hasSessionId = result.session_id != null;
  const isEmergency = result.is_emergency === true;
  const hasQuestion = result.question != null || result.text != null || result.message != null;
  const hasExpectedField = hasSessionId || isEmergency || hasQuestion;
  const underTimeLimit = time < 30;

  const pass = hasExpectedField && underTimeLimit;
  let reason = '';
  if (!hasExpectedField) reason += 'MISSING_FIELD ';
  if (!underTimeLimit) reason += 'TIMEOUT ';

  return {
    index: index + 1,
    input: symptom || '(empty)',
    category: categories[index],
    session_id: result.session_id || null,
    is_emergency: result.is_emergency || false,
    has_question: hasQuestion,
    response_keys: Object.keys(result),
    time,
    pass,
    reason: reason.trim() || 'OK',
    raw_snippet: JSON.stringify(result).substring(0, 200),
  };
}

async function main() {
  console.log('=== SYMPTOM INPUT API TEST (50 inputs) ===');
  console.log('Endpoint: POST /api/mobile/checkin/script/start');
  console.log('Token user_id: 4');
  console.log('');

  // Run sequentially to avoid overwhelming the server
  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const label = `[${i + 1}/50]`;
    process.stdout.write(`${label} "${inputs[i] || '(empty)'}" ... `);
    const r = await runTest(i, inputs[i]);
    results.push(r);
    console.log(`${r.pass ? 'PASS' : 'FAIL'} (${r.time}s) ${r.reason}`);
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  console.log('\n========================================');
  console.log(`RESULTS: ${passed} PASS / ${failed} FAIL out of 50`);
  console.log('========================================\n');

  // Category breakdown
  const cats = {};
  for (const r of results) {
    if (!cats[r.category]) cats[r.category] = { pass: 0, fail: 0 };
    if (r.pass) cats[r.category].pass++; else cats[r.category].fail++;
  }
  console.log('By category:');
  for (const [cat, counts] of Object.entries(cats)) {
    console.log(`  ${cat}: ${counts.pass} pass / ${counts.fail} fail`);
  }

  // Failed details
  const failures = results.filter(r => !r.pass);
  if (failures.length > 0) {
    console.log('\n--- FAILURES ---');
    for (const f of failures) {
      console.log(`  #${f.index} [${f.category}] "${f.input}"`);
      console.log(`    reason: ${f.reason}`);
      console.log(`    keys: ${f.response_keys?.join(', ') || 'N/A'}`);
      console.log(`    snippet: ${f.raw_snippet || f.error}`);
    }
  }

  // Timing stats
  const times = results.map(r => r.time);
  console.log('\n--- TIMING ---');
  console.log(`  Min: ${Math.min(...times).toFixed(2)}s`);
  console.log(`  Max: ${Math.max(...times).toFixed(2)}s`);
  console.log(`  Avg: ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}s`);

  // Emergency detection
  const emergencyInputs = results.filter(r => r.category === 'emergency');
  console.log('\n--- EMERGENCY DETECTION ---');
  for (const e of emergencyInputs) {
    console.log(`  #${e.index} "${e.input}" => is_emergency=${e.is_emergency}, session_id=${e.session_id}`);
  }

  // Full table
  console.log('\n--- FULL RESULTS TABLE ---');
  console.log('# | Category | Input | Pass | Time | session_id | emergency | has_q | Reason');
  console.log('-'.repeat(120));
  for (const r of results) {
    const inp = (r.input || '').substring(0, 35).padEnd(35);
    console.log(
      `${String(r.index).padStart(2)} | ${r.category.padEnd(10)} | ${inp} | ${r.pass ? 'PASS' : 'FAIL'} | ${String(r.time).padStart(6)}s | ${String(r.session_id || '-').padStart(10)} | ${String(r.is_emergency).padStart(5)} | ${String(r.has_question).padStart(5)} | ${r.reason}`
    );
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
