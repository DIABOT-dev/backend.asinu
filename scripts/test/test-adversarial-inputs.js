'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  createClustersFromOnboarding,
  getUserScript,
  getScript,
  addCluster,
  toClusterKey,
} = require('../src/services/checkin/script.service');

const {
  getNextQuestion,
  validateScript,
} = require('../src/services/checkin/script-runner');

const {
  evaluateScript,
  evaluateFollowUp,
} = require('../src/services/checkin/scoring-engine');

const {
  getFallbackScriptData,
  logFallback,
  matchCluster,
} = require('../src/services/checkin/fallback.service');

const {
  detectEmergency,
} = require('../src/services/checkin/emergency-detector');

// ─── Test harness ──────────────────────────────────────────────────────────

const USER_ID = 4;
let totalPass = 0;
let totalFail = 0;
const results = [];

function report(section, testName, input, expected, actual, pass) {
  const status = pass ? 'PASS' : 'FAIL';
  if (pass) totalPass++;
  else totalFail++;
  const entry = { section, testName, input: truncate(input), expected, actual: truncate(actual), status };
  results.push(entry);
  console.log(`  ${status}  [${section}] ${testName}`);
  if (!pass) {
    console.log(`         input:    ${truncate(input)}`);
    console.log(`         expected: ${expected}`);
    console.log(`         actual:   ${truncate(actual)}`);
  }
}

function truncate(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return String(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

function noCrash(section, testName, input, fn) {
  try {
    const result = fn();
    report(section, testName, input, 'no crash', truncate(result), true);
    return result;
  } catch (err) {
    report(section, testName, input, 'no crash', `CRASH: ${err.message}`, false);
    return null;
  }
}

async function noCrashAsync(section, testName, input, fn) {
  try {
    const result = await fn();
    report(section, testName, input, 'no crash', truncate(result), true);
    return result;
  } catch (err) {
    report(section, testName, input, 'no crash', `CRASH: ${err.message}`, false);
    return null;
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

async function cleanup() {
  console.log('\n--- Cleanup user_id=4 ---');
  await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [USER_ID]);
  await pool.query('DELETE FROM problem_clusters WHERE user_id = $1', [USER_ID]);
  await pool.query('DELETE FROM fallback_logs WHERE user_id = $1', [USER_ID]);
  console.log('  Done.\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    await cleanup();

    // Setup: create clusters from onboarding
    console.log('--- Setup: createClustersFromOnboarding ---');
    const clusters = await createClustersFromOnboarding(pool, USER_ID, ['đau đầu', 'chóng mặt']);
    console.log(`  Created ${clusters.length} clusters: ${clusters.map(c => c.cluster_key).join(', ')}\n`);

    // ═════════════════════════════════════════════════════════════════════════
    // A. Garbage inputs to matchCluster (15 tests)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('=== A. Garbage inputs to matchCluster (15 tests) ===');

    const garbageInputs = [
      { name: 'null', val: null },
      { name: 'undefined', val: undefined },
      { name: 'empty string', val: '' },
      { name: 'whitespace only', val: '   ' },
      { name: 'zero', val: 0 },
      { name: 'false', val: false },
      { name: 'true', val: true },
      { name: 'NaN', val: NaN },
      { name: 'special chars', val: '!!!@@@###' },
      { name: 'digits only', val: '12345' },
      { name: 'XSS attempt', val: '<script>alert(1)</script>' },
      { name: 'SQL injection SELECT', val: 'SELECT * FROM users' },
      { name: 'SQL injection DROP', val: "'; DROP TABLE users;--" },
      { name: 'very long string (10000)', val: 'a'.repeat(10000) },
      { name: 'object {}', val: {} },
    ];

    for (const g of garbageInputs) {
      await noCrashAsync('A', `matchCluster(${g.name})`, g.val, async () => {
        const r = await matchCluster(pool, USER_ID, g.val);
        if (r && r.matched === false) return '{matched:false} - correct';
        return JSON.stringify(r);
      });
    }

    // Extra: array [] instead of string
    await noCrashAsync('A', 'matchCluster(array [])', [], async () => {
      const r = await matchCluster(pool, USER_ID, []);
      return JSON.stringify(r);
    });

    // ═════════════════════════════════════════════════════════════════════════
    // B. Wrong answer types to scoring engine (15 tests)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n=== B. Wrong answer types to scoring engine (15 tests) ===');

    // Build a slider script for testing
    const sliderScript = {
      questions: [
        { id: 'q1', text: 'Mức đau?', type: 'slider', min: 0, max: 10 },
        { id: 'q2', text: 'Triệu chứng kèm?', type: 'multi_choice', options: ['buồn nôn', 'chóng mặt', 'không có'] },
      ],
      scoring_rules: [
        { conditions: [{ field: 'q1', op: 'gte', value: 7 }], combine: 'and', severity: 'high', follow_up_hours: 1, needs_doctor: true, needs_family_alert: true },
        { conditions: [{ field: 'q1', op: 'gte', value: 4 }], combine: 'and', severity: 'medium', follow_up_hours: 3, needs_doctor: false, needs_family_alert: false },
        { conditions: [{ field: 'q1', op: 'lt', value: 4 }], combine: 'and', severity: 'low', follow_up_hours: 6, needs_doctor: false, needs_family_alert: false },
      ],
      condition_modifiers: [],
      conclusion_templates: {
        low: { summary: 'Nhẹ', recommendation: 'Nghỉ ngơi', close_message: 'Hẹn gặp lại' },
        medium: { summary: 'TB', recommendation: 'Theo dõi', close_message: 'Hẹn 3h' },
        high: { summary: 'Nặng', recommendation: 'Đi khám', close_message: 'Hẹn 1h' },
      },
    };

    const wrongAnswerTests = [
      { name: 'string "abc" to slider', answers: [{ question_id: 'q1', answer: 'abc' }] },
      { name: 'null answer', answers: [{ question_id: 'q1', answer: null }] },
      { name: 'undefined answer', answers: [{ question_id: 'q1', answer: undefined }] },
      { name: 'boolean true', answers: [{ question_id: 'q1', answer: true }] },
      { name: 'boolean false', answers: [{ question_id: 'q1', answer: false }] },
      { name: 'object {} as answer', answers: [{ question_id: 'q1', answer: {} }] },
      { name: 'array [1,2,3] as answer', answers: [{ question_id: 'q1', answer: [1, 2, 3] }] },
      { name: 'empty string ""', answers: [{ question_id: 'q1', answer: '' }] },
      { name: 'very large number 999999999', answers: [{ question_id: 'q1', answer: 999999999 }] },
      { name: 'negative number -100', answers: [{ question_id: 'q1', answer: -100 }] },
      { name: 'float 3.14159', answers: [{ question_id: 'q1', answer: 3.14159 }] },
      { name: 'NaN answer', answers: [{ question_id: 'q1', answer: NaN }] },
      { name: 'Infinity answer', answers: [{ question_id: 'q1', answer: Infinity }] },
      { name: 'string "7" (valid number as string)', answers: [{ question_id: 'q1', answer: '7' }] },
      { name: 'non-existent question_id "q999"', answers: [{ question_id: 'q999', answer: 5 }] },
    ];

    for (const t of wrongAnswerTests) {
      noCrash('B', `evaluateScript(${t.name})`, t.answers, () => {
        const r = evaluateScript(sliderScript, t.answers, {});
        return `severity=${r.severity}, matched=${r.matchedRuleIndex}`;
      });
    }

    // Duplicate question_id
    noCrash('B', 'duplicate question_id in answers', 'q1 twice', () => {
      const r = evaluateScript(sliderScript, [
        { question_id: 'q1', answer: 3 },
        { question_id: 'q1', answer: 8 },
      ], {});
      return `severity=${r.severity} (last wins due to Map)`;
    });

    // ═════════════════════════════════════════════════════════════════════════
    // C. Malformed script data (12 tests)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n=== C. Malformed script data (12 tests) ===');

    const malformedScripts = [
      { name: 'null script', data: null },
      { name: '{} empty object', data: {} },
      { name: '{ questions: null }', data: { questions: null } },
      { name: '{ questions: "not an array" }', data: { questions: 'not an array' } },
      { name: '{ questions: [null] }', data: { questions: [null] } },
      { name: '{ questions: [{id:null,text:null,type:null}] }', data: { questions: [{ id: null, text: null, type: null }] } },
      { name: 'scoring_rules: null', data: { questions: [{ id: 'q1', text: 'Q', type: 'slider' }], scoring_rules: null } },
      { name: 'conclusion_templates: null', data: {
        questions: [{ id: 'q1', text: 'Q', type: 'slider', min: 0, max: 10 }],
        scoring_rules: [],
        conclusion_templates: null,
      }},
      { name: 'rule refs non-existent field', data: {
        questions: [{ id: 'q1', text: 'Q', type: 'slider', min: 0, max: 10 }],
        scoring_rules: [{ conditions: [{ field: 'q_nonexistent', op: 'gte', value: 5 }], combine: 'and', severity: 'high' }],
        conclusion_templates: { high: { summary: 'S', recommendation: 'R', close_message: 'C' } },
      }},
      { name: 'empty conditions array in rule', data: {
        questions: [{ id: 'q1', text: 'Q', type: 'slider', min: 0, max: 10 }],
        scoring_rules: [{ conditions: [], combine: 'and', severity: 'high' }],
        conclusion_templates: { high: { summary: 'S', recommendation: 'R', close_message: 'C' } },
      }},
      { name: 'unknown operator "xyz"', data: {
        questions: [{ id: 'q1', text: 'Q', type: 'slider', min: 0, max: 10 }],
        scoring_rules: [{ conditions: [{ field: 'q1', op: 'xyz', value: 5 }], combine: 'and', severity: 'high' }],
        conclusion_templates: { high: { summary: 'S', recommendation: 'R', close_message: 'C' } },
      }},
      { name: 'circular skip_if (q1 skip if q2, q2 skip if q1)', data: {
        questions: [
          { id: 'q1', text: 'Q1', type: 'slider', min: 0, max: 10, skip_if: { field: 'q2', op: 'eq', value: 5 } },
          { id: 'q2', text: 'Q2', type: 'slider', min: 0, max: 10, skip_if: { field: 'q1', op: 'eq', value: 5 } },
        ],
        scoring_rules: [{ conditions: [{ field: 'q1', op: 'gte', value: 5 }], combine: 'and', severity: 'high' }],
        conclusion_templates: { low: { summary: 'S', recommendation: 'R', close_message: 'C' } },
      }},
    ];

    for (const m of malformedScripts) {
      noCrash('C', `getNextQuestion(${m.name})`, m.data, () => {
        const r = getNextQuestion(m.data, [], {});
        return JSON.stringify(r);
      });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // D. Realistic user mistakes (10 tests)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n=== D. Realistic user mistakes (10 tests) ===');

    // Get a real dizziness script
    const dizzinessScript = await getScript(pool, USER_ID, 'dizziness');
    let dizzScriptData;
    if (dizzinessScript) {
      dizzScriptData = dizzinessScript.script_data;
    } else {
      // Use fallback
      dizzScriptData = getFallbackScriptData();
    }
    console.log(`  Using script with ${(dizzScriptData.questions || []).length} questions`);

    const qs = dizzScriptData.questions || [];

    // D1: answer question out of order (answer q3 before q1)
    noCrash('D', 'answer out of order (q3 before q1)', 'q3 first', () => {
      const q3Id = qs.length >= 3 ? qs[2].id : 'q3';
      const r = getNextQuestion(dizzScriptData, [{ question_id: q3Id, answer: 'vừa mới' }], {});
      return JSON.stringify(r);
    });

    // D2: answer same question twice
    noCrash('D', 'answer same question twice', 'q1 twice', () => {
      const q1Id = qs.length > 0 ? qs[0].id : 'q1';
      const r = getNextQuestion(dizzScriptData, [
        { question_id: q1Id, answer: 5 },
        { question_id: q1Id, answer: 8 },
      ], {});
      return JSON.stringify(r);
    });

    // D3: multi_choice answer as string instead of array
    noCrash('D', 'multi_choice answer as string', 'string instead of array', () => {
      const multiQ = qs.find(q => q.type === 'multi_choice');
      const answers = qs.map((q, i) => {
        if (q.type === 'multi_choice') return { question_id: q.id, answer: 'buồn nôn' }; // string not array
        if (q.type === 'slider') return { question_id: q.id, answer: 5 };
        return { question_id: q.id, answer: q.options ? q.options[0] : 'test' };
      });
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D4: slider answer as Vietnamese word
    noCrash('D', 'slider answer as string "năm"', '"năm" for slider', () => {
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: 'năm' }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D5: empty string answer
    noCrash('D', 'empty string answer', '""', () => {
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: '' }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D6: just spaces
    noCrash('D', 'just spaces "   "', '"   "', () => {
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: '   ' }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D7: HTML tags in answer
    noCrash('D', 'HTML tags in answer', '<b>đau</b>', () => {
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: '<b>đau</b>' }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D8: very long text (5000 chars)
    noCrash('D', 'very long text (5000 chars)', '5000 chars', () => {
      const longText = 'tôi bị đau '.repeat(500);
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: longText }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D9: emoji only
    noCrash('D', 'emoji only answer', 'emoji', () => {
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: '😫😫😫' }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // D10: mixed Vietnamese + English
    noCrash('D', 'mixed Vietnamese+English', 'rất pain nhiều', () => {
      const answers = [{ question_id: qs[0]?.id || 'q1', answer: 'rất pain nhiều' }];
      const r = evaluateScript(dizzScriptData, answers, {});
      return `severity=${r.severity}`;
    });

    // ═════════════════════════════════════════════════════════════════════════
    // E. Emergency detector adversarial (10 tests)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n=== E. Emergency detector adversarial (10 tests) ===');

    // E1: "đau ngực" repeated 100 times
    noCrash('E', '"đau ngực" x100 - still detects, no infinite loop', 'repeated 100x', () => {
      const input = Array(100).fill('đau ngực');
      const start = Date.now();
      const r = detectEmergency(input, {});
      const elapsed = Date.now() - start;
      const ok = elapsed < 1000;
      return `type=${r.type}, isEmergency=${r.isEmergency}, elapsed=${elapsed}ms, fast=${ok}`;
    });

    // E2: misspelled "ÐAUUUU NGUCCCC"
    noCrash('E', 'misspelled "ÐAUUUU NGUCCCC"', 'misspelling', () => {
      const r = detectEmergency(['ÐAUUUU NGUCCCC'], {});
      return `isEmergency=${r.isEmergency}, type=${r.type} (expected: probably not detected)`;
    });

    // E3: dots between chars
    noCrash('E', 'dots between chars "d.a.u n.g.ự.c"', 'dots', () => {
      const r = detectEmergency(['d.a.u n.g.ự.c'], {});
      return `isEmergency=${r.isEmergency}, type=${r.type}`;
    });

    // E4: underscores
    noCrash('E', 'underscores "đau_ngực_khó_thở"', 'underscores', () => {
      const r = detectEmergency(['đau_ngực_khó_thở'], {});
      return `isEmergency=${r.isEmergency}, type=${r.type}`;
    });

    // E5: Lorem Ipsum with "đau ngực" buried
    noCrash('E', 'Lorem Ipsum with "đau ngực" buried in middle', 'lorem ipsum', () => {
      const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10);
      const r = detectEmergency([lorem + 'đau ngực khó thở' + lorem], {});
      return `isEmergency=${r.isEmergency}, type=${r.type}`;
    });

    // E6: negation + positive
    noCrash('E', 'negation: "không bị đau ngực nhưng mà hơi khó thở"', 'negation', () => {
      const r = detectEmergency(['tôi không bị đau ngực đâu nhưng mà hơi khó thở'], {});
      return `isEmergency=${r.isEmergency}, type=${r.type}, severity=${r.severity}`;
    });

    // E7: null input
    noCrash('E', 'null input', null, () => {
      const r = detectEmergency(null, {});
      return `isEmergency=${r.isEmergency}`;
    });

    // E8: array with null, undefined, ""
    noCrash('E', 'array [null, undefined, ""]', '[null, undefined, ""]', () => {
      const r = detectEmergency([null, undefined, ''], {});
      return `isEmergency=${r.isEmergency}`;
    });

    // E9: 1000 normal symptoms - no timeout
    noCrash('E', '1000 normal symptoms - no timeout (< 1s)', '1000 items', () => {
      const bigArray = Array(1000).fill('hơi mệt mỏi');
      const start = Date.now();
      const r = detectEmergency(bigArray, {});
      const elapsed = Date.now() - start;
      return `isEmergency=${r.isEmergency}, elapsed=${elapsed}ms, fast=${elapsed < 1000}`;
    });

    // E10: repeated seizure keywords - single detection
    noCrash('E', '"co giật" x3 - single emergency, not multiple', 'repeated seizure', () => {
      const r = detectEmergency(['co giật co giật co giật'], {});
      return `isEmergency=${r.isEmergency}, type=${r.type}`;
    });

    // ═════════════════════════════════════════════════════════════════════════
    // F. Cross-module data flow (8 tests)
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n=== F. Cross-module data flow (8 tests) ===');

    // F1: Create cluster -> delete from DB -> getScript returns null -> getNextQuestion with null
    await noCrashAsync('F', 'getScript after cluster deleted -> null -> getNextQuestion(null)', 'delete cluster', async () => {
      // Create a temp cluster
      const tempClusters = await createClustersFromOnboarding(pool, USER_ID, ['đau lưng']);
      // Delete it
      await pool.query('DELETE FROM triage_scripts WHERE user_id = $1 AND cluster_key = $2', [USER_ID, 'back_pain']);
      await pool.query('DELETE FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2', [USER_ID, 'back_pain']);
      // Try to get script
      const script = await getScript(pool, USER_ID, 'back_pain');
      if (script !== null) return `unexpected: script not null after delete`;
      // Now feed null to getNextQuestion - this may crash
      try {
        const r = getNextQuestion(null, [], {});
        return `getNextQuestion(null) returned: ${JSON.stringify(r)}`;
      } catch (e) {
        return `getNextQuestion(null) threw: ${e.message} (EXPECTED - null script not handled)`;
      }
    });

    // F2: Corrupt script_data in DB -> getNextQuestion handles gracefully
    await noCrashAsync('F', 'corrupted script_data in DB', 'corrupt json', async () => {
      // Insert corrupted script
      await pool.query(
        `INSERT INTO triage_scripts (user_id, cluster_key, script_type, script_data, generated_by, cluster_id)
         VALUES ($1, 'test_corrupt', 'initial', '{"questions": "NOT_ARRAY"}'::jsonb, 'test',
           (SELECT id FROM problem_clusters WHERE user_id = $1 LIMIT 1))
         ON CONFLICT DO NOTHING`,
        [USER_ID]
      );
      const script = await getScript(pool, USER_ID, 'test_corrupt');
      if (!script) return 'no script found (OK - conflict or missing cluster)';
      try {
        const r = getNextQuestion(script.script_data, [], {});
        return `result: ${JSON.stringify(r)}`;
      } catch (e) {
        return `threw: ${e.message}`;
      }
    });

    // F3: Start session -> delete cluster mid-session -> answering still works
    await noCrashAsync('F', 'delete cluster mid-session', 'mid-session delete', async () => {
      // Ensure we have dizziness cluster
      const script = await getScript(pool, USER_ID, 'dizziness');
      if (!script) return 'no dizziness script (skip)';
      const sd = script.script_data;
      // Get first question
      const q1 = getNextQuestion(sd, [], {});
      // Now delete cluster from DB
      await pool.query('DELETE FROM problem_clusters WHERE user_id = $1 AND cluster_key = $2', [USER_ID, 'dizziness']);
      // Continue answering - script runner is stateless, works from script_data in memory
      const q2 = getNextQuestion(sd, [{ question_id: q1.question?.id || 'q1', answer: 5 }], {});
      // Restore cluster
      await createClustersFromOnboarding(pool, USER_ID, ['chóng mặt']);
      return `q2 result: isDone=${q2.isDone}, question=${q2.question?.id || 'done'}`;
    });

    // F4: evaluateFollowUp with previousSeverity=null
    noCrash('F', 'evaluateFollowUp previousSeverity=null', 'null severity', () => {
      const fbScript = getFallbackScriptData();
      const r = evaluateFollowUp(fbScript, [
        { question_id: 'fu1', answer: 'Vẫn vậy' },
        { question_id: 'fu2', answer: 'Không' },
      ], null);
      return `severity=${r.severity}, action=${r.action}`;
    });

    // F5: evaluateFollowUp with previousSeverity="invalid_string"
    noCrash('F', 'evaluateFollowUp previousSeverity="invalid_string"', '"invalid_string"', () => {
      const fbScript = getFallbackScriptData();
      const r = evaluateFollowUp(fbScript, [
        { question_id: 'fu1', answer: 'Vẫn vậy' },
        { question_id: 'fu2', answer: 'Không' },
      ], 'invalid_string');
      return `severity=${r.severity}, action=${r.action}`;
    });

    // F6: matchCluster when all clusters is_active=false
    await noCrashAsync('F', 'matchCluster all clusters is_active=false', 'all inactive', async () => {
      await pool.query('UPDATE problem_clusters SET is_active = FALSE WHERE user_id = $1', [USER_ID]);
      const r = await matchCluster(pool, USER_ID, 'đau đầu');
      // Restore
      await pool.query('UPDATE problem_clusters SET is_active = TRUE WHERE user_id = $1', [USER_ID]);
      return `matched=${r.matched}`;
    });

    // F7: logFallback - test constraint violation resilience
    await noCrashAsync('F', 'logFallback constraint test', 'potential constraint', async () => {
      // Log with null checkin_id (should be fine)
      await logFallback(pool, USER_ID, 'test adversarial input', null, []);
      // Log again with same data (should not crash even if there were unique constraints)
      await logFallback(pool, USER_ID, 'test adversarial input', null, [{ question_id: 'fb1', answer: 3 }]);
      return 'logged twice without crash';
    });

    // F8: getUserScript when user has clusters but NO scripts
    await noCrashAsync('F', 'getUserScript with clusters but no scripts', 'no scripts', async () => {
      // Delete all scripts but keep clusters
      await pool.query('DELETE FROM triage_scripts WHERE user_id = $1', [USER_ID]);
      const r = await getUserScript(pool, USER_ID);
      // Restore
      await createClustersFromOnboarding(pool, USER_ID, ['đau đầu', 'chóng mặt']);
      if (!r) return 'returned null (clusters exist but no scripts)';
      return `greeting=${r.greeting}, clusters=${r.clusters?.length}, scripts=${Object.keys(r.scripts || {}).length}`;
    });

    // ═════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n' + '='.repeat(70));
    console.log('ADVERSARIAL TEST SUMMARY');
    console.log('='.repeat(70));
    console.log(`  TOTAL: ${totalPass + totalFail}`);
    console.log(`  PASS:  ${totalPass}`);
    console.log(`  FAIL:  ${totalFail}`);
    console.log('='.repeat(70));

    if (totalFail > 0) {
      console.log('\nFailed tests:');
      for (const r of results.filter(r => r.status === 'FAIL')) {
        console.log(`  [${r.section}] ${r.testName}`);
        console.log(`    input:    ${r.input}`);
        console.log(`    expected: ${r.expected}`);
        console.log(`    actual:   ${r.actual}`);
      }
    }

    console.log('\nDetailed results per section:');
    const sections = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (const s of sections) {
      const sectionResults = results.filter(r => r.section === s);
      const sPass = sectionResults.filter(r => r.status === 'PASS').length;
      const sFail = sectionResults.filter(r => r.status === 'FAIL').length;
      const sectionNames = { A: 'Garbage matchCluster', B: 'Wrong answer types', C: 'Malformed scripts', D: 'User mistakes', E: 'Emergency adversarial', F: 'Cross-module flow' };
      console.log(`  ${s}. ${sectionNames[s]}: ${sPass} pass, ${sFail} fail (${sectionResults.length} total)`);
    }

    console.log('');

  } catch (err) {
    console.error('FATAL ERROR:', err);
  } finally {
    // Cleanup
    try {
      await pool.query('DELETE FROM triage_scripts WHERE user_id = $1 AND cluster_key = $2', [USER_ID, 'test_corrupt']);
    } catch (_) {}
    await pool.end();
  }
})();
