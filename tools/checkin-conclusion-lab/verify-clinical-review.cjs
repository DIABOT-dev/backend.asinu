'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { verifyReview } = require('./clinical-review.cjs');
const argument = (name) =>
  process.argv.find((arg) => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
try {
  const packetFile = argument('packet'),
    approvalFile = argument('approval');
  if (!packetFile || !approvalFile)
    throw new Error('Supply --packet=<file> and --approval=<human-completed record>.');
  const result = verifyReview(
    JSON.parse(fs.readFileSync(packetFile)),
    JSON.parse(fs.readFileSync(approvalFile)),
    path.resolve(__dirname, '../..')
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.recordComplete) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
