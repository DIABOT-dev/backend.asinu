'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SOURCE_FILES = [
  'src/core/checkin/triage-conclusion.js',
  'src/core/checkin/triage-conclusion-contract.js',
  'src/core/checkin/triage-conclusion-guards.js',
  'src/core/checkin/triage-conclusion-prompt.js',
  'src/core/checkin/triage-ai-layer.js',
  'src/core/checkin/triage-engine.js',
  'src/i18n/locales/vi.json',
  'src/i18n/locales/en.json',
  'src/lib/honorifics.js',
];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const sourceHashes = (root) =>
  Object.fromEntries(
    SOURCE_FILES.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    ])
  );
function createPacket(report, audit, root) {
  if (
    report.cases.length !== 30 ||
    audit.cases.length !== 30 ||
    audit.metrics.finalOutputIssues !== 0 ||
    !audit.metrics.ac4Pass
  )
    throw new Error(
      'A passing 30-case technical audit is required before final clinical sign-off.'
    );
  const hashes = sourceHashes(root);
  for (const [name, hash] of Object.entries(audit.sourcesSha256))
    if (hashes['src/core/checkin/' + name] !== hash) throw new Error('Audit source is stale.');
  const content = {
    sourcesSha256: hashes,
    model: {
      id: 'medgemma-27b-it',
      temperature: 0.2,
      maxTokens: 700,
      timeoutMs: 10000,
      retries: 0,
    },
    disclaimers: Object.fromEntries(
      ['vi', 'en'].map((lang) => [
        lang,
        JSON.parse(fs.readFileSync(path.join(root, 'src/i18n/locales/' + lang + '.json')))[
          'checkin.conclusion.disclaimer'
        ],
      ])
    ),
    samples: audit.cases.map((item) => ({
      id: item.id,
      lang: item.lang,
      facts: item.facts,
      output: item.output,
      outputSha256: digest(item.output),
    })),
    metrics: audit.metrics,
  };
  return {
    schema: 'asinu-checkin-clinical-review-v1',
    createdAt: new Date().toISOString(),
    bundleSha256: digest(content),
    content,
  };
}
function reviewTemplate(packet) {
  return {
    schema: packet.schema,
    bundleSha256: packet.bundleSha256,
    clinicalReviewer: { name: '', qualification: '', reviewedAt: '', attestsQualified: false },
    reviews: packet.content.samples.map((sample) => ({
      id: sample.id,
      outputSha256: sample.outputSha256,
      decision: 'pending',
      notes: '',
    })),
    p6: {
      name: '',
      reviewedAt: '',
      approved: false,
      disclaimerSha256: digest(packet.content.disclaimers),
    },
  };
}
function verifyReview(packet, record, root) {
  const errors = [];
  if (
    packet.schema !== 'asinu-checkin-clinical-review-v1' ||
    digest(packet.content) !== packet.bundleSha256
  )
    errors.push('PACKET_TAMPERED');
  if (record.schema !== packet.schema || record.bundleSha256 !== packet.bundleSha256)
    errors.push('WRONG_PACKET');
  const current = sourceHashes(root);
  for (const file of SOURCE_FILES)
    if (current[file] !== packet.content.sourcesSha256[file]) errors.push('SOURCE_CHANGED:' + file);
  const validDate = (value) =>
    typeof value === 'string' &&
    value.length >= 20 &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= Date.now() + 300000;
  if (
    !record.clinicalReviewer?.name?.trim() ||
    !record.clinicalReviewer?.qualification?.trim() ||
    !record.clinicalReviewer?.attestsQualified ||
    !validDate(record.clinicalReviewer?.reviewedAt)
  )
    errors.push('CLINICAL_REVIEWER_MISSING');
  const reviews = new Map();
  for (const review of record.reviews || []) {
    if (reviews.has(review.id)) errors.push('DUPLICATE_REVIEW:' + review.id);
    reviews.set(review.id, review);
  }
  if (reviews.size !== 30 || packet.content.samples.length !== 30)
    errors.push('THIRTY_REVIEWS_REQUIRED');
  for (const sample of packet.content.samples) {
    const review = reviews.get(sample.id);
    if (
      sample.outputSha256 !== digest(sample.output) ||
      review?.outputSha256 !== sample.outputSha256
    )
      errors.push('OUTPUT_CHANGED:' + sample.id);
    if (review?.decision !== 'approved') errors.push('CLINICAL_APPROVAL_MISSING:' + sample.id);
  }
  if (
    !record.p6?.name?.trim() ||
    !record.p6?.approved ||
    !validDate(record.p6?.reviewedAt) ||
    record.p6?.disclaimerSha256 !== digest(packet.content.disclaimers)
  )
    errors.push('P6_APPROVAL_MISSING');
  if (
    process.env.CHECKIN_CONCLUSION_MODEL &&
    process.env.CHECKIN_CONCLUSION_MODEL !== packet.content.model.id
  )
    errors.push('MODEL_CHANGED');
  return {
    recordComplete: errors.length === 0,
    errors,
    identityOrMedicalQualificationVerifiedByTool: false,
    note: 'This checks the recorded human sign-off and its exact version. The responsible organization must verify the reviewers and their qualifications; software is not clinical approval.',
  };
}
module.exports = { SOURCE_FILES, digest, sourceHashes, createPacket, reviewTemplate, verifyReview };
