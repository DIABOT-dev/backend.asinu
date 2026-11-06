'use strict';
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {
  SOURCE_FILES,
  sourceHashes,
  createPacket,
  reviewTemplate,
  verifyReview,
} = require('../../tools/checkin-conclusion-lab/clinical-review.cjs');
let root, packet;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asinu-clinical-review-test-'));
  for (const file of SOURCE_FILES) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      file.endsWith('.json')
        ? JSON.stringify({ 'checkin.conclusion.disclaimer': 'Synthetic test disclaimer' })
        : 'synthetic source ' + file
    );
  }
  const samples = Array.from({ length: 30 }, (_, i) => ({
    id: 'synthetic-' + i,
    lang: i === 29 ? 'en' : 'vi',
    facts: {},
    output: { personalMessage: 'Synthetic test output ' + i },
  }));
  const hashes = sourceHashes(root);
  const audit = {
    cases: samples,
    metrics: { finalOutputIssues: 0, ac4Pass: true },
    sourcesSha256: { 'triage-conclusion.js': hashes['src/core/checkin/triage-conclusion.js'] },
  };
  packet = createPacket({ cases: samples }, audit, root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
// Positive fixtures live in memory only. They never create a real approval
// file and never claim that this test reviewer is a medical professional.
function completeSyntheticRecord() {
  const record = reviewTemplate(packet),
    at = new Date().toISOString();
  record.clinicalReviewer = {
    name: 'Synthetic test reviewer',
    qualification: 'Synthetic test credential',
    reviewedAt: at,
    attestsQualified: true,
  };
  for (const review of record.reviews) review.decision = 'approved';
  record.p6 = { ...record.p6, name: 'Synthetic test P6', reviewedAt: at, approved: true };
  return record;
}
test('preparation always leaves every clinical and P6 decision pending', () => {
  const record = reviewTemplate(packet);
  expect(record.reviews.every((row) => row.decision === 'pending')).toBe(true);
  expect(record.p6.approved).toBe(false);
  expect(verifyReview(packet, record, root).recordComplete).toBe(false);
});
test('complete correctly versioned records can be validated without claiming identity verification', () => {
  const result = verifyReview(packet, completeSyntheticRecord(), root);
  expect(result).toMatchObject({
    recordComplete: true,
    errors: [],
    identityOrMedicalQualificationVerifiedByTool: false,
  });
});
test.each([
  ['missing case', (record) => record.reviews.pop(), 'THIRTY_REVIEWS_REQUIRED'],
  [
    'duplicate case',
    (record) => (record.reviews[1] = record.reviews[0]),
    'DUPLICATE_REVIEW:synthetic-0',
  ],
  [
    'changed sample',
    (record) => (record.reviews[0].outputSha256 = 'other'),
    'OUTPUT_CHANGED:synthetic-0',
  ],
  ['wrong bundle', (record) => (record.bundleSha256 = 'other'), 'WRONG_PACKET'],
  ['missing P6', (record) => (record.p6.approved = false), 'P6_APPROVAL_MISSING'],
  [
    'missing qualification',
    (record) => (record.clinicalReviewer.qualification = ''),
    'CLINICAL_REVIEWER_MISSING',
  ],
  [
    'case rejected by reviewer',
    (record) => (record.reviews[0].decision = 'changes_requested'),
    'CLINICAL_APPROVAL_MISSING:synthetic-0',
  ],
])('%s blocks acceptance', (label, change, error) => {
  const record = completeSyntheticRecord();
  change(record);
  expect(verifyReview(packet, record, root).errors).toContain(error);
});
test('changing source after review invalidates the recorded sign-off', () => {
  const record = completeSyntheticRecord();
  fs.appendFileSync(path.join(root, SOURCE_FILES[0]), ' changed');
  expect(verifyReview(packet, record, root).errors).toContain('SOURCE_CHANGED:' + SOURCE_FILES[0]);
});
test('changing content inside the review packet is detected', () => {
  const record = completeSyntheticRecord();
  packet.content.samples[0].output.personalMessage = 'different';
  expect(verifyReview(packet, record, root).errors).toContain('PACKET_TAMPERED');
});
test('a failing technical acceptance run cannot produce the final clinical packet', () => {
  expect(() =>
    createPacket(
      { cases: Array(30) },
      { cases: Array(30), metrics: { finalOutputIssues: 0, ac4Pass: false } },
      root
    )
  ).toThrow('passing 30-case');
});
