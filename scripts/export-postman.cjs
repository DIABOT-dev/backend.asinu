#!/usr/bin/env node
'use strict';

// Static export: never starts the server, loads .env, or contacts a database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const espree = require('espree');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'postman');
const examples = require('../postman/examples.cjs');
const cache = new Map();
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const source = (file, node) => file.text.slice(node.range[0], node.range[1]);
const property = (node) => node?.computed ? node.property.value : node?.property?.name;
function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visit(node, parents);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'tokens', 'comments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, [...parents, node]));
    else if (value?.type) walk(value, visit, [...parents, node]);
  }
}
function read(relative) {
  const absolute = path.resolve(root, relative);
  if (cache.has(absolute)) return cache.get(absolute);
  const text = fs.readFileSync(absolute, 'utf8');
  const ast = espree.parse(text, { ecmaVersion: 'latest', loc: true, range: true, comment: true });
  const file = { absolute, relative: path.relative(root, absolute), text, ast, symbols: new Map(), imports: new Map(), properties: new Map() };
  cache.set(absolute, file);
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) file.symbols.set(node.id.name, node);
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier') file.symbols.set(node.id.name, node.init);
      let required = node.init;
      if (required?.type === 'CallExpression' && required.callee.type === 'CallExpression') required = required.callee;
      if (required?.type === 'CallExpression' && required.callee.name === 'require' && required.arguments[0]?.value?.startsWith('.')) {
        let target = path.resolve(path.dirname(absolute), required.arguments[0].value);
        if (!fs.existsSync(target)) target += '.js';
        if (node.id.type === 'Identifier') file.imports.set(node.id.name, { target });
        if (node.id.type === 'ObjectPattern') for (const item of node.id.properties) file.imports.set(item.value.name, { target, member: item.key.name });
      }
    }
    if (node.type === 'Property') {
      const name = node.key.name || node.key.value;
      if (name) file.properties.set(name, node.value);
    }
  });
  return file;
}
function resolve(file, node, seen = new Set()) {
  if (!node) return [];
  const key = file.relative + ':' + node.range?.[0];
  if (seen.has(key)) return [];
  seen = new Set([...seen, key]);
  const imported = (binding, member) => {
    if (!fs.existsSync(binding.target)) return [];
    const target = read(binding.target);
    return resolve(target, target.symbols.get(member) || target.properties.get(member), seen);
  };
  if (node.type === 'Identifier') {
    const binding = file.imports.get(node.name);
    if (binding?.member) return imported(binding, binding.member);
    return resolve(file, file.symbols.get(node.name), seen);
  }
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
    const name = property(node), binding = file.imports.get(node.object.name);
    if (binding) return imported(binding, name);
    const factory = file.symbols.get(node.object.name);
    if (factory?.type === 'CallExpression' && factory.callee.type === 'Identifier') {
      const factoryImport = file.imports.get(factory.callee.name);
      if (factoryImport) return imported(factoryImport, name);
    }
    return resolve(file, file.properties.get(name), seen);
  }
  if (node.type === 'CallExpression') return node.arguments.flatMap((arg) => resolve(file, arg, seen));
  if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)) return [{ file, node }];
  return [];
}
function fields(handlers) {
  const found = { body: new Set(), query: new Set(), headers: new Set(), schemas: new Set() };
  for (const { file, node } of handlers) {
    const aliases = new Map([['req', []]]);
    const requestPath = (value) => {
      if (value?.type === 'ChainExpression') return requestPath(value.expression);
      if (value?.type === 'Identifier') return aliases.get(value.name);
      if (value?.type === 'MemberExpression') {
        const prefix = requestPath(value.object);
        if (prefix) return [...prefix, property(value)];
      }
      if (value?.type === 'LogicalExpression') return requestPath(value.left);
      return undefined;
    };
    walk(node, (child) => {
      if (child.type === 'VariableDeclarator') {
        const prefix = requestPath(child.init);
        if (prefix && child.id.type === 'Identifier') aliases.set(child.id.name, prefix);
        if (prefix && child.id.type === 'ObjectPattern') for (const item of child.id.properties) {
          if (found[prefix[0]] && prefix.length === 1 && item.key) found[prefix[0]].add(item.key.name || item.key.value);
        }
      }
      if (child.type === 'MemberExpression') {
        const parts = requestPath(child);
        if (parts?.length >= 2 && found[parts[0]]) found[parts[0]].add(parts[1]);
      }
      if (child.type === 'CallExpression' && child.callee.type === 'MemberExpression' && ['safeParse', 'parse'].includes(property(child.callee))) {
        if (requestPath(child.arguments[0])?.[0] === 'body') found.schemas.add(source(file, child.callee.object));
      }
    });
  }
  return Object.fromEntries(Object.entries(found).map(([key, value]) => [key, [...value].filter(Boolean)]));
}
function routerCalls(file, object) {
  const calls = [];
  walk(file.ast, (node, parents) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.object.name !== object) return;
    const method = property(node.callee);
    if (!methods.has(method) && method !== 'use') return;
    calls.push({ node, method, parents });
  });
  return calls.sort((a, b) => a.node.range[0] - b.node.range[0]);
}
const server = read('server.js');
const routes = [];
function collect(file, object, prefix, group) {
  const middleware = [];
  for (const call of routerCalls(file, object)) {
    const { node, method, parents } = call;
    const routePath = node.arguments[0]?.value;
    if (method === 'use') {
      if (typeof routePath !== 'string') middleware.push(...node.arguments);
      continue;
    }
    if (typeof routePath !== 'string') throw new Error('Unsupported dynamic route: ' + file.relative + ':' + node.loc.start.line);
    const handlers = node.arguments.slice(1).flatMap((arg) => resolve(file, arg));
    const text = [...middleware, ...node.arguments.slice(1)].map((arg) => source(file, arg)).join('\n');
    const auth = /requireCronSecret/.test(text) ? 'cron' : /requireDoctorSignature/.test(text) || group === 'doctor-profile' ? 'doctor-hmac' : /requireGooglePubSubAuth/.test(text) ? 'google-pubsub' : /requireAuth|requireBrainAuth/.test(text) ? 'bearer' : 'none';
    routes.push({
      method: method.toUpperCase(), path: prefix + (routePath === '/' ? '' : routePath), group,
      auth: routePath === '/api/healthz/detailed' ? 'health-token' : auth,
      source: file.relative + ':' + node.loc.start.line,
      handlers: [...new Set(handlers.map(({ file: f, node: n }) => f.relative + ':' + n.loc.start.line))],
      fields: fields(handlers),
      upload: [...text.matchAll(/\.single\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]),
      aiConsent: /requireAiConsent/.test(text),
      devOnly: parents.some((parent) => parent.type === 'IfStatement' && /NODE_ENV/.test(source(file, parent.test))),
    });
  }
}
collect(server, 'app', '', 'system');
for (const { node, method } of routerCalls(server, 'app')) {
  if (method !== 'use' || typeof node.arguments[0]?.value !== 'string') continue;
  const prefix = node.arguments[0].value;
  const mount = node.arguments.at(-1);
  if (mount?.type !== 'CallExpression') continue;
  let target;
  if (mount.callee.type === 'Identifier') target = server.imports.get(mount.callee.name)?.target;
  if (mount.callee.type === 'CallExpression' && mount.callee.callee.name === 'require') target = path.resolve(root, mount.callee.arguments[0].value + '.js');
  if (!target) continue;
  const file = read(target);
  const group = path.basename(target).replace(/\.routes\.js$/, '');
  const routerNames = new Set();
  walk(file.ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'CallExpression' && node.init.callee.type === 'MemberExpression' && node.init.callee.object.name === 'express' && property(node.init.callee) === 'Router') routerNames.add(node.id.name);
  });
  if (!routerNames.size) throw new Error('No Express router found in ' + file.relative);
  for (const name of routerNames) collect(file, name, prefix, group);
}
const names = new Set();
for (const route of routes) {
  const key = route.method + ' ' + route.path;
  if (names.has(key)) throw new Error('Duplicate endpoint: ' + key);
  names.add(key);
}
const variables = new Map(Object.entries(examples.variables));
function variable(name, value = '') { if (!variables.has(name)) variables.set(name, String(value)); return '{{' + name + '}}'; }
function pathVariable(route, name) {
  const key = examples.pathVariable(route.path, name);
  variable(key);
  return key;
}
function sample(key) {
  const value = examples.fieldValues[key];
  return value === undefined ? variable(key) : value;
}
function event(listen, code) { return { listen, script: { type: 'text/javascript', exec: code.trim().split('\n') } }; }
const groups = new Map();
for (const route of routes) {
  const key = route.method + ' ' + route.path;
  const config = examples.requests[key] || {};
  const events = [];
  const headers = [{ key: 'Accept-Language', value: '{{language}}' }];
  const pathParts = route.path.split('/').filter(Boolean);
  const urlVariables = [];
  const urlPath = pathParts.map((part) => part.replace(/:([a-zA-Z_][a-zA-Z_0-9]*)/g, (_, name) => {
    const value = variable(pathVariable(route, name));
    urlVariables.push({ key: name, value, description: 'Điền ID thật từ response tương ứng.' });
    return ':' + name;
  }));
  let query = Object.entries(config.query || {}).map(([key, value]) => ({ key, value: String(value), ...(config.requiredQuery?.includes(key) ? {} : { disabled: true }) }));
  for (const key of route.fields.query) if (!query.some((q) => q.key === key)) query.push({ key, value: String(sample(key)), disabled: true });
  const queryString = query.filter((q) => !q.disabled).map((q) => q.key + '=' + q.value).join('&');
  const url = { raw: '{{base_url}}/' + urlPath.join('/') + (queryString ? '?' + queryString : ''), host: ['{{base_url}}'], path: urlPath, ...(query.length ? { query } : {}), ...(urlVariables.length ? { variable: urlVariables } : {}) };
  const auth = route.auth === 'bearer' ? undefined : { type: 'noauth' };
  if (route.auth === 'cron') headers.push({ key: 'x-cron-secret', value: variable('cron_secret') });
  if (route.auth === 'health-token') headers.push({ key: 'x-health-token', value: variable('health_check_token') });
  if (route.auth === 'google-pubsub') headers.push({ key: 'Authorization', value: 'Bearer ' + variable('google_pubsub_oidc_token') });
  if (route.path === '/api/payments/webhook') headers.push({ key: 'Authorization', value: 'Apikey ' + variable('sepay_api_key') });
  if (route.path.includes('/user-audio/')) headers.push({ key: 'X-Checkin-Notice-Version', value: variable('notice_version') });
  let body;
  const form = config.form || (route.upload.length ? Object.fromEntries(route.upload.map((key) => [key, { file: true }])) : undefined);
  if (form) {
    body = { mode: 'formdata', formdata: Object.entries(form).map(([key, value]) => value?.file ? { key, type: 'file', src: [] } : { key, type: 'text', value: String(value) }) };
  } else if (config.body !== undefined || route.fields.body.length) {
    const data = config.body === undefined ? Object.fromEntries(route.fields.body.filter((key) => key !== 'user_id').map((key) => [key, sample(key)])) : config.body;
    const raw = JSON.stringify(data, null, 2).replace(/"\{\{([^{}]+)\}\}"/g, (match, name) => examples.numericVariables.includes(name) ? '{{' + name + '}}' : match);
    body = { mode: 'raw', raw, options: { raw: { language: 'json' } } };
    headers.push({ key: 'Content-Type', value: 'application/json' });
  }
  if (route.auth === 'doctor-hmac') events.push(event('prerequest', examples.doctorSignature));
  if (config.pre) events.push(event('prerequest', config.pre));
  if (config.test) events.push(event('test', config.test));
  const note = [
    '`' + key + '`', 'Nguồn: `' + route.source + '`.',
    'Xác thực: ' + ({ bearer: 'JWT `{{access_token}}` (kế thừa collection).', none: 'Không dùng JWT; có thể cần capability hoặc chữ ký từ nhà cung cấp.', cron: 'Header `x-cron-secret: {{cron_secret}}`.', 'doctor-hmac': 'HMAC SHA-256 tự tạo bằng `{{doctor_integration_secret}}` và timestamp.', 'health-token': 'Header `x-health-token`.', 'google-pubsub': 'OIDC token Google Pub/Sub trong `{{google_pubsub_oidc_token}}`.' })[route.auth],
    route.handlers.length ? 'Handler: ' + route.handlers.map((file) => '`' + file + '`').join(', ') + '.' : '',
    route.aiConsent ? 'Cần cấp AI consent bằng GET rồi PUT `/api/mobile/ai-consent`.' : '',
    route.devOnly ? 'Chỉ được đăng ký khi NODE_ENV khác production; production trả 404.' : '',
    route.fields.schemas.length ? 'Validation: ' + route.fields.schemas.map((name) => '`' + name + '`').join(', ') + '.' : '',
    form ? 'Chọn file thật ở Body → form-data. Postman tự đặt multipart boundary.' : '',
    route.fields.query.length ? 'Query tùy chọn được để tắt mặc định; bật các tham số bạn cần ở Params.' : '',
    !['GET', 'HEAD', 'OPTIONS'].includes(route.method) ? 'Request có thể thay đổi dữ liệu, gửi thông báo hoặc gọi dịch vụ tính phí. Dùng tài khoản và dữ liệu test; kiểm tra body trước khi Send.' : '',
    config.note || '',
  ].filter(Boolean).join('\n\n');
  const item = { name: key, request: { method: route.method, header: headers, ...(auth ? { auth } : {}), url, ...(body ? { body } : {}), description: note }, ...(events.length ? { event: events } : {}), response: [] };
  let group = examples.group(route);
  if (route.devOnly) group = '90. Development only';
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(item);
}
const collection = {
  info: { _postman_id: '39536640-2a32-5f2b-89c8-d2850c813000', name: 'Asinu — All Backend APIs', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: examples.description + '\n\nTổng: ' + routes.length + ' endpoint HTTP, trích xuất tĩnh từ server.js và các router được mount. WebSocket Doctor chat: /api/doctor/chat/ws?tenant_id={{tenant_id}}&task_id={{task_id}}; tạo WebSocket request riêng, header Sec-WebSocket-Protocol: asinu-chat, {{access_token}}. Chi tiết trong README.txt.' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }] },
  event: [event('prerequest', examples.collectionPre), event('test', examples.collectionTest)],
  variable: [],
  item: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ name, item })),
};
const serialized = JSON.stringify(collection);
for (const match of serialized.matchAll(/\{\{([^{}]+)\}\}/g)) if (!match[1].startsWith('$')) variable(match[1]);
const templates = collection.item;
const runtimeKeys = new Set(['now_iso', 'now_ms', 'month', 'asinu_mode']);
const keys = [...variables.keys()].filter((key) => !runtimeKeys.has(key));
const modes = [['local', 'Local API', 'http://localhost:3300'], ['production', 'Production API', 'https://asinu.top']];
collection.variable = modes.flatMap(([mode, _name, baseUrl]) => [...variables].filter(([key]) => !runtimeKeys.has(key)).map(([key, value]) => ({ key: mode + '_' + key, value: key === 'base_url' ? baseUrl : value, type: 'string' })));
collection.item = modes.map(([mode, name]) => {
  const item = JSON.parse(JSON.stringify(templates));
  for (const folder of item) for (const requestItem of folder.item) {
    requestItem.request.url.raw = requestItem.request.url.raw.replace('{{base_url}}', '{{' + mode + '_base_url}}');
    requestItem.request.url.host = ['{{' + mode + '_base_url}}'];
  }
  const scopeScript = `
pm.variables.set('asinu_mode', '${mode}');
for (const key of ${JSON.stringify(keys)}) {
  const scoped = '${mode}_' + key;
  const value = pm.environment.get(scoped);
  pm.variables.set(key, value === undefined ? pm.collectionVariables.get(scoped) || '' : value);
}
const requestKey = '__${mode}_request_id_' + pm.info.requestName;
let requestId = pm.variables.get('request_id') || pm.collectionVariables.get(requestKey);
if (!requestId) { requestId = pm.variables.replaceIn('{{$guid}}'); pm.collectionVariables.set(requestKey, requestId); }
pm.variables.set('request_id', requestId);
`;
  return { name, description: routes.length + ' API. Điền ' + mode + '_email và ' + mode + '_password rồi đăng nhập trong folder này. URL: {{' + mode + '_base_url}}. Token, ID và khóa nội bộ dùng riêng các biến có tiền tố ' + mode + '_.', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{' + mode + '_access_token}}', type: 'string' }] }, event: [event('prerequest', scopeScript)], item };
});
collection.auth = { type: 'noauth' };
fs.mkdirSync(out, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
write('Asinu.postman_collection.json', collection);
const smokePaths = new Set(['GET /healthz', 'GET /api/healthz', 'GET /api/readyz', 'GET /api/iap/products']);
write('Asinu-Smoke.postman_collection.json', {
  ...collection,
  info: { ...collection.info, _postman_id: '47736640-2a32-5f2b-89c8-d2850c813000', name: 'Asinu — Public smoke checks', description: 'Mỗi folder môi trường có 4 GET request công khai để kiểm tra kết nối, Redis/database readiness và danh mục IAP. Không cần đăng nhập.' },
  auth: { type: 'noauth' },
  item: collection.item.map((folder) => ({ ...folder, description: '4 GET request công khai của ' + folder.name + '.', item: folder.item.flatMap((group) => group.item).filter((item) => smokePaths.has(item.name)) })),
});
for (const [name, baseUrl] of [['Local', 'http://localhost:3300'], ['Production', 'https://asinu.top']]) {
  write('Asinu-' + name + '.postman_environment.json', {
    id: crypto.createHash('md5').update('asinu-postman-' + name).digest('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5'),
    name: 'Asinu — ' + name,
    values: collection.variable.filter(({ key }) => key.startsWith(name.toLowerCase() + '_') && examples.environmentKeys.includes(key.slice(name.length + 1))).map(({ key, value }) => ({ key, value, type: /secret|token|password/.test(key) ? 'secret' : 'default', enabled: true })),
    _postman_variable_scope: 'environment',
  });
}
write('api-inventory.json', { total: routes.length, groups: Object.fromEntries([...groups].map(([name, items]) => [name, items.length])), endpoints: routes });
console.log('Exported Local API and Production API: ' + routes.length + ' HTTP endpoints and ' + groups.size + ' feature groups each.');
console.log('No server, database, credentials, or external APIs were accessed.');
