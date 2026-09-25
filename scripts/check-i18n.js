'use strict';

const fs = require('fs');
const path = require('path');
const espree = require('espree');
const { NOTIF_MAP } = require('../src/constants');
const { generatedEntries } = require('../src/services/health_feed/seed');

const root = path.resolve(__dirname, '..');
const localeDir = path.join(root, 'src/i18n/locales');
const vi = JSON.parse(fs.readFileSync(path.join(localeDir, 'vi.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const errors = [];

function placeholders(value) {
  if (typeof value !== 'string') return [];
  const languageSpecific = new Set([
    'CallName',
    'callName',
    'Honorific',
    'honorific',
    'SelfRef',
    'selfRef',
  ]);
  return [...value.matchAll(/\{\{([^{}]+)\}\}/g)]
    .map((match) => match[1])
    .filter((name) => !languageSpecific.has(name))
    .sort();
}

for (const key of new Set([...Object.keys(vi), ...Object.keys(en)])) {
  if (!(key in vi)) errors.push(`missing Vietnamese key: ${key}`);
  if (!(key in en)) errors.push(`missing English key: ${key}`);
  if (!(key in vi) || !(key in en)) continue;
  if (typeof vi[key] !== typeof en[key]) errors.push(`type mismatch: ${key}`);
  if (typeof vi[key] === 'string' && !vi[key].trim()) {
    errors.push(`empty Vietnamese value: ${key}`);
  }
  if (typeof en[key] === 'string' && !en[key].trim()) {
    errors.push(`empty English value: ${key}`);
  }

  const viParams = placeholders(vi[key]);
  const enParams = placeholders(en[key]);
  if (viParams.join('|') !== enParams.join('|')) {
    errors.push(`placeholder mismatch: ${key} (vi=${viParams.join(',')} en=${enParams.join(',')})`);
  }
}

for (const [type, keys] of Object.entries(NOTIF_MAP)) {
  if (!Array.isArray(keys) || keys.length !== 2) {
    errors.push(`notification test map has invalid entry: ${type}`);
    continue;
  }
  for (const key of keys) {
    if (!(key in vi) || !(key in en)) {
      errors.push(`notification test map references missing key: ${type} -> ${key}`);
    }
  }
}

const viHealthFeed = JSON.parse(
  fs.readFileSync(path.join(root, 'src/services/health_feed/seedData.json'), 'utf8')
);
const enHealthFeed = JSON.parse(
  fs.readFileSync(path.join(root, 'src/services/health_feed/seedData.en.json'), 'utf8')
);
const expectedHealthFeedIds = new Set([
  ...(viHealthFeed.content_items || []).map((entry) => String(entry.id)),
  ...generatedEntries().map((entry) => String(entry.id)),
]);
const englishHealthFeedById = new Map(
  (enHealthFeed.content_items || []).map((entry) => [String(entry.id), entry])
);

for (const id of expectedHealthFeedIds) {
  const entry = englishHealthFeedById.get(id);
  if (!entry) {
    errors.push(`health feed is missing English content: ${id}`);
    continue;
  }
  for (const field of ['title', 'summary', 'body', 'cta_label']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) {
      errors.push(`health feed English ${field} is empty: ${id}`);
    }
  }
  if (!Array.isArray(entry.checklist) || entry.checklist.some((item) => !String(item).trim())) {
    errors.push(`health feed English checklist is invalid: ${id}`);
  }
}
for (const id of englishHealthFeedById.keys()) {
  if (!expectedHealthFeedIds.has(id)) errors.push(`health feed has unknown English content: ${id}`);
}

function sourceFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(absolute));
    else if (entry.name.endsWith('.js')) result.push(absolute);
  }
  return result;
}

function calleeName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.type === 'Identifier'
  ) {
    return node.property.name;
  }
  return null;
}

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const [property, value] of Object.entries(node)) {
    if (property === 'loc' || property === 'range') continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walk(child, visitor);
    } else if (value?.type) {
      walk(value, visitor);
    }
  }
}

for (const file of sourceFiles(path.join(root, 'src'))) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
    const key = match[1];
    if (key.endsWith('.')) continue;
    if (!(key in vi) || !(key in en)) {
      const line = source.slice(0, match.index).split('\n').length;
      errors.push(`${path.relative(root, file)}:${line}: translation key does not exist: ${key}`);
    }
  }

  let ast;
  try {
    ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
  } catch (error) {
    errors.push(`${path.relative(root, file)}: JavaScript parse failed (${error.message})`);
    continue;
  }

  const collectCopy = (node, output = []) => {
    if (!node) return output;
    if (node.type === 'Literal' && typeof node.value === 'string' && /[A-Za-zÀ-ỹ]/u.test(node.value)) {
      output.push(node.value);
      return output;
    }
    if (node.type === 'TemplateLiteral') {
      for (const part of node.quasis) {
        const value = part.value.cooked || '';
        if (/[A-Za-zÀ-ỹ]/u.test(value)) output.push(value);
      }
      return output;
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      (node.callee.name === 't' || node.callee.name === 'tt')
    ) {
      return output;
    }
    for (const [property, value] of Object.entries(node)) {
      if (property === 'loc' || property === 'range') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) collectCopy(child, output);
      } else if (value?.type) {
        collectCopy(value, output);
      }
    }
    return output;
  };

  const notificationArguments = {
    sendAndSave: [3, 4],
    sendPushNotification: [1, 2],
    saveInAppNotification: [3, 4],
  };
  const relativeFile = path.relative(root, file);
  const localizedApiFiles = new Set([
    'src/controllers/script-checkin.controller.js',
    'src/services/health_feed/controller.js',
  ]);

  walk(ast, (node) => {
    if (
      relativeFile === 'src/services/profile/mobile.service.js' &&
      node.type === 'AssignmentExpression' &&
      node.left.type === 'Identifier' &&
      ['title', 'body'].includes(node.left.name)
    ) {
      const copy = collectCopy(node.right, []).filter(
        (value) => value.trim() && !/^[a-z0-9_.:/-]+$/i.test(value.trim())
      );
      if (copy.length) {
        errors.push(
          `${relativeFile}:${node.loc.start.line}: health alert contains hard-coded user copy (${copy.join(' | ')})`
        );
      }
    }

    if (node.type !== 'CallExpression') return;
    const name = calleeName(node.callee);
    if (Object.prototype.hasOwnProperty.call(notificationArguments, name)) {
      for (const index of notificationArguments[name]) {
        const copy = [...new Set(collectCopy(node.arguments[index], []))].filter(
          (value) => value.trim() && !/^[a-z0-9_.:/-]+$/i.test(value.trim())
        );
        if (copy.length) {
          errors.push(
            `${path.relative(root, file)}:${node.loc.start.line}: ${name} contains hard-coded user copy (${copy.join(' | ')})`
          );
        }
      }
    }

    if (
      localizedApiFiles.has(relativeFile) &&
      name === 'json' &&
      node.arguments[0]?.type === 'ObjectExpression'
    ) {
      for (const property of node.arguments[0].properties) {
        if (property.type !== 'Property') continue;
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
        if (!['error', 'message', 'title', 'body'].includes(key)) continue;
        const copy = collectCopy(property.value, []).filter(
          (value) => /\s/u.test(value.trim()) && /[A-Za-zÀ-ỹ]/u.test(value)
        );
        if (copy.length) {
          errors.push(
            `${path.relative(root, file)}:${property.loc.start.line}: API ${key} contains hard-coded user copy (${copy.join(' | ')})`
          );
        }
      }
    }

  });
}

if (errors.length > 0) {
  console.error(`Backend i18n check failed (${errors.length} issues):`);
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Backend i18n check passed: ${Object.keys(vi).length} aligned vi/en keys.`);
}
