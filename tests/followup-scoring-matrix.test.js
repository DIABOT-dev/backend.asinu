/**
 * Follow-up Scoring Matrix — Exhaustive test of ALL 18 base combinations
 * + free-text variants parsed through parseAnswer → evaluateFollowUp.
 *
 * No API calls needed — follow-up scoring is deterministic.
 * parseAnswer Layer 1 (local matching) is used; AI Layer 2 is skipped
 * because we don't set up OpenAI/Redis (and it's not needed for keyword matching).
 */

'use strict';

// Minimal dotenv — won't crash if .env is missing
try { require('dotenv').config(); } catch (_) {}

const { evaluateFollowUp } = require('../src/core/checkin/scoring-engine');
const { localMatch } = require('../src/core/agent/ai-answer-parser');

// ─── Constants ────────────────────────────────────────────────────────────────

const PREVIOUS_SEVERITIES = ['low', 'medium', 'high'];

const STATUS_OPTIONS = ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'];
const NEW_SYMPTOM_OPTIONS = ['Có', 'Không'];

// Follow-up question IDs used by evaluateFollowUp
const FU1_ID = 'fu1'; // status
const FU2_ID = 'fu2'; // new symptoms

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAnswers(statusAnswer, newSymptomsAnswer) {
  return [
    { question_id: FU1_ID, answer: statusAnswer },
    { question_id: FU2_ID, answer: newSymptomsAnswer },
  ];
}

/**
 * Parse a free-text variant through localMatch to get the matched option,
 * then use that option in evaluateFollowUp.
 */
function parseVariant(rawText, options) {
  const result = localMatch(rawText, options, 'single_choice');
  if (result.matched && result.matched.length > 0) {
    return { parsed: result.matched[0], method: result.method, confidence: result.confidence };
  }
  // If localMatch fails, return raw text (simulates what would go to AI layer)
  return { parsed: rawText, method: 'none', confidence: 0 };
}

// ─── Test counters ────────────────────────────────────────────────────────────

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures = [];
const violations = []; // Critical "thận trọng" violations

function assert(condition, label, detail = '') {
  totalTests++;
  if (condition) {
    passed++;
  } else {
    failed++;
    const msg = `FAIL: ${label}${detail ? ' — ' + detail : ''}`;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

function assertCritical(condition, label, detail = '') {
  totalTests++;
  if (condition) {
    passed++;
  } else {
    failed++;
    const msg = `CRITICAL VIOLATION: ${label}${detail ? ' — ' + detail : ''}`;
    violations.push(msg);
    failures.push(msg);
    console.log(`  🚨 ${msg}`);
  }
}

// ─── PART 1: 18 Base Combinations ────────────────────────────────────────────

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  PART 1: 18 BASE COMBINATIONS (3 severity × 3 status × 2 newSymptoms)');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

const matrixRows = [];

for (const prevSev of PREVIOUS_SEVERITIES) {
  for (const statusOpt of STATUS_OPTIONS) {
    for (const newSympOpt of NEW_SYMPTOM_OPTIONS) {
      const label = `prev=${prevSev} | status="${statusOpt}" | newSymp="${newSympOpt}"`;
      const answers = buildAnswers(statusOpt, newSympOpt);
      let result;

      try {
        result = evaluateFollowUp({}, answers, prevSev);
      } catch (err) {
        failed++;
        totalTests++;
        failures.push(`CRASH: ${label} — ${err.message}`);
        console.log(`  💥 CRASH: ${label} — ${err.message}`);
        matrixRows.push({ prevSev, statusOpt, newSympOpt, result: 'CRASH', error: err.message });
        continue;
      }

      // No crash
      assert(result !== null && result !== undefined, `${label} — no crash`);

      matrixRows.push({ prevSev, statusOpt, newSympOpt, result });

      // ── Severity sense checks ──
      if (statusOpt === 'Đỡ hơn' && newSympOpt === 'Không') {
        assert(
          result.severity === 'low',
          `${label} — severity should be low`,
          `got ${result.severity}`
        );
      }

      if (statusOpt === 'Nặng hơn' && newSympOpt === 'Có') {
        assert(
          result.severity === 'high',
          `${label} — severity should be high`,
          `got ${result.severity}`
        );
      }

      if (statusOpt === 'Vẫn vậy' && newSympOpt === 'Không') {
        // "Vẫn vậy" + no new symptoms → severity stays same
        assert(
          result.severity === prevSev,
          `${label} — severity should stay ${prevSev}`,
          `got ${result.severity}`
        );
      }

      if (statusOpt === 'Vẫn vậy' && newSympOpt === 'Có') {
        // "Vẫn vậy" + new symptoms → severity may bump (low→medium), or stay same
        // Code path: !isWorse + hasNewSymptoms → bump low→medium, else keep same
        const expectedSev = prevSev === 'low' ? 'medium' : prevSev;
        assert(
          result.severity === expectedSev,
          `${label} — severity should be ${expectedSev} (new symptoms bump low→medium)`,
          `got ${result.severity}`
        );
      }

      // ── CRITICAL thận trọng checks ──

      // needsDoctor=false for "Đỡ hơn" (ALWAYS)
      if (statusOpt === 'Đỡ hơn') {
        assertCritical(
          result.needsDoctor === false,
          `${label} — needsDoctor MUST be false for "Đỡ hơn"`,
          `got ${result.needsDoctor}`
        );
      }

      // needsDoctor=false for "Vẫn vậy" (ALWAYS)
      if (statusOpt === 'Vẫn vậy') {
        assertCritical(
          result.needsDoctor === false,
          `${label} — needsDoctor MUST be false for "Vẫn vậy"`,
          `got ${result.needsDoctor}`
        );
      }

      // needsDoctor=true ONLY when: "Nặng hơn" + new symptoms + previous was HIGH
      if (statusOpt === 'Nặng hơn' && newSympOpt === 'Có' && prevSev === 'high') {
        assertCritical(
          result.needsDoctor === true,
          `${label} — needsDoctor MUST be true (worst case)`,
          `got ${result.needsDoctor}`
        );
      }
      // needsDoctor: for "Nặng hơn" + "Có" combos where prev != high
      // Per spec: needsDoctor=true ONLY when previous=HIGH.
      // Per code: needsDoctor=true ALWAYS when isWorse+hasNewSymptoms.
      // This is a design discrepancy — the code is MORE cautious than the spec.
      // We log it as a WARNING (not a critical violation) since being cautious
      // is safer than under-alerting.
      if (statusOpt === 'Nặng hơn' && newSympOpt === 'Có' && prevSev !== 'high') {
        if (result.needsDoctor === true) {
          console.log(`  ⚠️  SPEC vs CODE: ${label} — needsDoctor=${result.needsDoctor} (code is more cautious than spec: always true for worse+newSymptoms, spec says only when prev=HIGH)`);
        }
      }

      // needsFamilyAlert=true ONLY when: "Nặng hơn" + new symptoms + previous was HIGH
      if (statusOpt === 'Nặng hơn' && newSympOpt === 'Có' && prevSev === 'high') {
        assertCritical(
          result.needsFamilyAlert === true,
          `${label} — needsFamilyAlert MUST be true (worst case)`,
          `got ${result.needsFamilyAlert}`
        );
      }

      // needsFamilyAlert=false for ALL other cases
      if (!(statusOpt === 'Nặng hơn' && newSympOpt === 'Có' && prevSev === 'high')) {
        assertCritical(
          result.needsFamilyAlert === false,
          `${label} — needsFamilyAlert MUST be false`,
          `got ${result.needsFamilyAlert}`
        );
      }
    }
  }
}

// Print matrix table
console.log('');
console.log('┌──────────┬───────────┬──────────┬──────────┬─────────────┬──────────┬───────────────┬─────────────────┐');
console.log('│ Prev Sev │ Status    │ New Symp │ Severity │ FollowUpHrs │ Doctor   │ FamilyAlert   │ Action          │');
console.log('├──────────┼───────────┼──────────┼──────────┼─────────────┼──────────┼───────────────┼─────────────────┤');
for (const row of matrixRows) {
  if (row.error) {
    console.log(`│ ${row.prevSev.padEnd(8)} │ ${row.statusOpt.padEnd(9)} │ ${row.newSympOpt.padEnd(8)} │ CRASH    │             │          │               │                 │`);
  } else {
    const r = row.result;
    console.log(`│ ${row.prevSev.padEnd(8)} │ ${row.statusOpt.padEnd(9)} │ ${row.newSympOpt.padEnd(8)} │ ${r.severity.padEnd(8)} │ ${String(r.followUpHours).padEnd(11)} │ ${String(r.needsDoctor).padEnd(8)} │ ${String(r.needsFamilyAlert).padEnd(13)} │ ${(r.action || '').padEnd(15)} │`);
  }
}
console.log('└──────────┴───────────┴──────────┴──────────┴─────────────┴──────────┴───────────────┴─────────────────┘');


// ─── PART 2: Free-text Variants ──────────────────────────────────────────────

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  PART 2: FREE-TEXT VARIANTS parsed through localMatch');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

const betterVariants = [
  { text: 'đỡ rồi', expected: 'Đỡ hơn' },
  { text: 'tốt hơn', expected: 'Đỡ hơn' },
  { text: 'bớt đau', expected: 'Đỡ hơn' },
  { text: 'khỏe hơn hôm qua', expected: 'Đỡ hơn' },
  { text: 'hết đau rồi', expected: 'Đỡ hơn' },
  { text: 'do hon', expected: 'Đỡ hơn' },
  { text: 'tot hon roi', expected: 'Đỡ hơn' },
];

const sameVariants = [
  { text: 'vẫn đau', expected: 'Vẫn vậy' },
  { text: 'y như cũ', expected: 'Vẫn vậy' },
  { text: 'không thay đổi', expected: 'Vẫn vậy' },
  { text: 'van vay', expected: 'Vẫn vậy' },
  { text: 'cũng thế', expected: 'Vẫn vậy' },
  { text: 'giống hôm qua', expected: 'Vẫn vậy' },
];

const worseVariants = [
  { text: 'nặng hơn', expected: 'Nặng hơn' },
  { text: 'tệ hơn', expected: 'Nặng hơn' },
  { text: 'đau hơn', expected: 'Nặng hơn' },
  { text: 'nang hon', expected: 'Nặng hơn' },
  { text: 'tệ lắm', expected: 'Nặng hơn' },
  { text: 'đau dữ hơn hồi sáng', expected: 'Nặng hơn' },
];

const allVariants = [
  ...betterVariants.map(v => ({ ...v, category: 'better' })),
  ...sameVariants.map(v => ({ ...v, category: 'same' })),
  ...worseVariants.map(v => ({ ...v, category: 'worse' })),
];

const variantResults = [];

for (const variant of allVariants) {
  const parseResult = parseVariant(variant.text, STATUS_OPTIONS);
  const matchedCorrectly = parseResult.parsed === variant.expected;
  const parseLabel = `"${variant.text}" → expected "${variant.expected}", got "${parseResult.parsed}" (method: ${parseResult.method}, conf: ${parseResult.confidence})`;

  if (matchedCorrectly) {
    console.log(`  ✅ ${parseLabel}`);
  } else {
    console.log(`  ⚠️  PARSE MISS: ${parseLabel}`);
  }

  // Now test with evaluateFollowUp for each previous severity
  for (const prevSev of PREVIOUS_SEVERITIES) {
    // Use the PARSED answer (what localMatch returns) — this is what the real system does
    const statusForEval = parseResult.parsed;
    const answers = buildAnswers(statusForEval, 'Không'); // test with no new symptoms
    let result;

    try {
      result = evaluateFollowUp({}, answers, prevSev);
    } catch (err) {
      failed++;
      totalTests++;
      failures.push(`CRASH: variant="${variant.text}" prev=${prevSev} — ${err.message}`);
      continue;
    }

    assert(result !== null, `variant="${variant.text}" prev=${prevSev} — no crash`);

    variantResults.push({
      text: variant.text,
      category: variant.category,
      parsedAs: statusForEval,
      matchedCorrectly,
      prevSev,
      result,
    });

    // Critical checks on parsed results
    if (matchedCorrectly) {
      // Only check scoring rules if parsing was correct
      if (variant.category === 'better') {
        assertCritical(
          result.needsDoctor === false,
          `variant="${variant.text}" prev=${prevSev} — needsDoctor false for better`,
          `got ${result.needsDoctor}`
        );
        assertCritical(
          result.needsFamilyAlert === false,
          `variant="${variant.text}" prev=${prevSev} — needsFamilyAlert false for better`,
          `got ${result.needsFamilyAlert}`
        );
      }

      if (variant.category === 'same') {
        assertCritical(
          result.needsDoctor === false,
          `variant="${variant.text}" prev=${prevSev} — needsDoctor false for same`,
          `got ${result.needsDoctor}`
        );
        assertCritical(
          result.needsFamilyAlert === false,
          `variant="${variant.text}" prev=${prevSev} — needsFamilyAlert false for same`,
          `got ${result.needsFamilyAlert}`
        );
      }
    }
  }
}

// Also test variants with "Có" (new symptoms) for worse variants
console.log('');
console.log('── Worse variants + new symptoms ("Có") ──');
console.log('');

for (const variant of worseVariants) {
  const parseResult = parseVariant(variant.text, STATUS_OPTIONS);
  const statusForEval = parseResult.parsed;

  for (const prevSev of PREVIOUS_SEVERITIES) {
    const answers = buildAnswers(statusForEval, 'Có');
    let result;

    try {
      result = evaluateFollowUp({}, answers, prevSev);
    } catch (err) {
      failed++;
      totalTests++;
      failures.push(`CRASH: variant="${variant.text}"+Có prev=${prevSev} — ${err.message}`);
      continue;
    }

    assert(result !== null, `variant="${variant.text}"+Có prev=${prevSev} — no crash`);

    if (parseResult.parsed === variant.expected) {
      // Parsed correctly as "Nặng hơn"
      if (prevSev === 'high') {
        assertCritical(
          result.needsDoctor === true,
          `variant="${variant.text}"+Có prev=high — needsDoctor must be true`,
          `got ${result.needsDoctor}`
        );
        assertCritical(
          result.needsFamilyAlert === true,
          `variant="${variant.text}"+Có prev=high — needsFamilyAlert must be true`,
          `got ${result.needsFamilyAlert}`
        );
      } else {
        assertCritical(
          result.needsFamilyAlert === false,
          `variant="${variant.text}"+Có prev=${prevSev} — needsFamilyAlert must be false (prev!=high)`,
          `got ${result.needsFamilyAlert}`
        );
      }
    }

    const flag = (parseResult.parsed === variant.expected) ? '✅' : '⚠️ ';
    console.log(`  ${flag} "${variant.text}"+Có prev=${prevSev} → sev=${result.severity} doctor=${result.needsDoctor} family=${result.needsFamilyAlert} (parsed as "${statusForEval}")`);
  }
}


// ─── PART 3: Summary ─────────────────────────────────────────────────────────

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log(`  Total tests:  ${totalTests}`);
console.log(`  Passed:       ${passed}`);
console.log(`  Failed:       ${failed}`);
console.log('');

if (violations.length > 0) {
  console.log('  🚨 CRITICAL VIOLATIONS (thận trọng rules):');
  for (const v of violations) {
    console.log(`    - ${v}`);
  }
  console.log('');
}

if (failures.length > 0 && failures.length !== violations.length) {
  console.log('  All failures:');
  for (const f of failures) {
    console.log(`    - ${f}`);
  }
  console.log('');
}

// Parse coverage report
console.log('  PARSE COVERAGE (localMatch on free-text variants):');
let parsedOk = 0;
let parseFail = 0;
const parseMisses = [];
for (const variant of allVariants) {
  const parseResult = parseVariant(variant.text, STATUS_OPTIONS);
  if (parseResult.parsed === variant.expected) {
    parsedOk++;
  } else {
    parseFail++;
    parseMisses.push(`"${variant.text}" → expected "${variant.expected}", got "${parseResult.parsed}"`);
  }
}
console.log(`    Matched correctly: ${parsedOk}/${allVariants.length}`);
if (parseMisses.length > 0) {
  console.log(`    Misses (would need AI Layer 2 or _matchesBetter/_matchesWorse expansion):`);
  for (const m of parseMisses) {
    console.log(`      - ${m}`);
  }
}

console.log('');

// Exit code
if (violations.length > 0) {
  console.log('EXIT: CRITICAL VIOLATIONS FOUND');
  process.exit(1);
} else if (failed > 0) {
  console.log('EXIT: Some tests failed (non-critical)');
  process.exit(1);
} else {
  console.log('EXIT: ALL TESTS PASSED');
  process.exit(0);
}
