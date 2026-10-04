'use strict';

const fs = require('fs');
const path = require('path');
const espree = require('espree');

const sourceRoot = path.resolve(__dirname, '../../src');

function visit(node, inspect) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, inspect));
    return;
  }
  if (typeof node.type === 'string') inspect(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'parent') visit(child, inspect);
  }
}

test('routes and controllers contain no direct database or network I/O', () => {
  const violations = [];
  for (const folder of ['routes', 'controllers']) {
    const directory = path.join(sourceRoot, folder);
    for (const filename of fs.readdirSync(directory).filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(directory, filename), 'utf8');
      const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
      visit(ast, (node) => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          ['pool', 'client'].includes(callee.object.name) &&
          ['query', 'connect'].includes(callee.property.name)
        ) {
          violations.push(`${folder}/${filename}:${node.loc.start.line}: direct database access`);
        }
        if (callee.type === 'Identifier' && callee.name === 'fetch') {
          violations.push(`${folder}/${filename}:${node.loc.start.line}: direct network request`);
        }
      });
    }
  }
  expect(violations).toEqual([]);
});

test('extracted routes only wire controllers and middleware', () => {
  const routeFiles = [
    'checkin-call.routes.js',
    'checkin-call.ops.routes.js',
    'voice.routes.js',
    'household.routes.js',
    'early-signal.routes.js',
    'doctor-task.routes.js',
    'doctor-profile.routes.js',
  ];
  const violations = [];
  for (const filename of routeFiles) {
    const source = fs.readFileSync(path.join(sourceRoot, 'routes', filename), 'utf8');
    const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
    visit(ast, (node) => {
      if (
        (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
        node.async
      ) {
        violations.push(`${filename}:${node.loc.start.line}: async handler belongs in controller`);
      }
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments[0]?.type === 'Literal' &&
        typeof node.arguments[0].value === 'string' &&
        node.arguments[0].value.startsWith('../services/')
      ) {
        violations.push(`${filename}:${node.loc.start.line}: route imports a service`);
      }
    });
  }
  expect(violations).toEqual([]);
});

test('controller route callbacks cannot drop rejected promises on Express 4', () => {
  const violations = [];
  for (const filename of fs
    .readdirSync(path.join(sourceRoot, 'routes'))
    .filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(sourceRoot, 'routes', filename), 'utf8');
    const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
    visit(ast, (node) => {
      if (
        node.type === 'ArrowFunctionExpression' &&
        node.params.map((param) => param.name).join(',') === 'req,res' &&
        node.body.type === 'CallExpression' &&
        node.body.callee.type === 'Identifier' &&
        node.body.arguments.map((arg) => arg.name).join(',') === 'pool,req,res'
      ) {
        violations.push(
          `${filename}:${node.loc.start.line}: use bindController for async error forwarding`
        );
      }
    });
  }
  expect(violations).toEqual([]);
});
