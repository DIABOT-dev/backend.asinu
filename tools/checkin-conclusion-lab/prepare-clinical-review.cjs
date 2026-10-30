'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { createPacket, reviewTemplate } = require('./clinical-review.cjs');
const { renderClinicalReview } = require('./clinical-review-html.cjs');
const round = process.argv.find((arg) => arg.startsWith('--round='))?.slice(8);
if (!round || !/^[a-z0-9-]{1,24}$/.test(round))
  throw new Error('Supply a validated --round label.');
const root = path.resolve(__dirname, '../..');
const directory = path.resolve(
  root,
  '../../preview/checkin-conclusion-implementation-20261029-' + round
);
const report = JSON.parse(fs.readFileSync(path.join(directory, 'results.json')));
const audit = JSON.parse(fs.readFileSync(path.join(directory, 'srs-audit.json')));
const packet = createPacket(report, audit, root);
const documents = [
  ['clinical-review-packet.json', packet],
  ['clinical-approval-template.json', reviewTemplate(packet)],
  ['clinical-review.html', renderClinicalReview(packet)],
];
for (const [name] of documents) {
  const file = path.join(directory, name);
  if (fs.existsSync(file))
    throw new Error('Refusing to overwrite an existing review record: ' + name);
}
for (const [name, data] of documents)
  fs.writeFileSync(
    path.join(directory, name),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' }
  );
console.log(
  JSON.stringify({
    preparedCases: 30,
    bundleSha256: packet.bundleSha256,
    clinicalApproval: 'pending',
    p6Approval: 'pending',
  })
);
