/*
 * Static contract check for ASINU -> CRM events.
 *
 * This intentionally checks the source tree rather than the database. It is a
 * fast CI guard that catches a catalog entry without a real emitter and also
 * prevents deferred health/service events from being emitted accidentally.
 */

const fs = require('fs');
const path = require('path');
const {
  CRM_DEFERRED_EVENT_TYPES,
  CRM_PHASE_ONE_EVENT_TYPES,
} = require('../src/services/integrations/crm-event.catalog');

const sourceRoot = path.join(__dirname, '..', 'src');
const ignoredFiles = new Set([
  path.join(sourceRoot, 'services', 'integrations', 'crm-event.catalog.js'),
  path.join(sourceRoot, 'services', 'integrations', 'crm-event.service.js'),
  // The policy mirrors the complete contract for source-side filtering. Its
  // event names are not emitters and must not count as premature emissions.
  path.join(sourceRoot, 'services', 'integrations', 'crm-event.policy.js'),
]);

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.js') && !ignoredFiles.has(fullPath))
      files.push(fullPath);
  }
  return files;
}

const source = collectJavaScriptFiles(sourceRoot)
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

const hasEventLiteral = (eventType) =>
  new RegExp(`['"]${eventType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(source);

const missingPhaseOne = CRM_PHASE_ONE_EVENT_TYPES.filter(
  (eventType) => !hasEventLiteral(eventType)
);
const prematurelyEmitted = CRM_DEFERRED_EVENT_TYPES.filter(hasEventLiteral);

if (missingPhaseOne.length || prematurelyEmitted.length) {
  console.error(JSON.stringify({ ok: false, missingPhaseOne, prematurelyEmitted }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: true,
      phaseOneEvents: CRM_PHASE_ONE_EVENT_TYPES.length,
      deferredEvents: CRM_DEFERRED_EVENT_TYPES.length,
    })
  );
}
