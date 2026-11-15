'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const { z } = require('zod');
const { actionSchema } = require('./app-actions.schema');
const domain = require('./domain-tools.schema');
const native = new Map(actionSchema.options.map(schema => [schema.shape.type.value, schema]));
const own = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
const frontmatterSchema = z.object({ name: identifier, description: z.string().trim().min(1).max(500),
  metadata: z.object({ asinu: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), group: identifier,
    selector: z.record(z.string(), z.string()), context: z.object({ medication: z.boolean(), profile: z.boolean() }).strict(),
  }).strict() }).passthrough(),
}).passthrough();

function splitDocument(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match || match[1].length > 8000) throw new Error('Invalid skill frontmatter');
  return { header: match[1], body: content.slice(match[0].length).trim() };
}
function argumentsSchema(selector) {
  const base = native.get(selector.type);
  if (!base) throw new Error('Unsupported skill capability');
  const expected = selector.type === 'app_tool' ? ['type', 'tool'] : selector.type === 'query' ? ['type', 'topic']
    : selector.type === 'navigate' ? ['type', 'destination'] : ['type'];
  if (Object.keys(selector).sort().join() !== expected.sort().join()) throw new Error('Invalid skill capability selector');
  if (selector.type === 'app_tool') {
    if (!own(domain.definitions, selector.tool)) throw new Error('Unsupported skill tool');
    const schema = domain.definitions[selector.tool];
    return z.object({ parameters: schema.safeParse({}).success ? schema.default({}) : schema, evidence: base.shape.evidence }).strict();
  }
  if (selector.type === 'query' && !base.shape.topic.options.includes(selector.topic)) throw new Error('Unsupported skill query');
  if (selector.type === 'navigate' && !base.shape.destination.options.includes(selector.destination)) throw new Error('Unsupported skill screen');
  let schema = base.omit(Object.fromEntries(expected.map(key => [key, true]))).strict();
  if (selector.type === 'query' && ['profile', 'medication', 'reminders'].includes(selector.topic))
    schema = schema.extend({ range: z.literal('today').default('today'), statistic: z.literal('list').default('list') });
  else if (selector.type === 'query' && ['water', 'meal'].includes(selector.topic))
    schema = schema.extend({ statistic: z.literal('list').default('list') });
  return schema;
}
// A short input contract is derived from the real server schema. Skill files
// describe the workflow; they cannot redefine API fields or grant new powers.
function compact(schema) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join('|');
  if (schema.anyOf) return schema.anyOf.map(compact).join('|');
  if (schema.type === 'array') return `[${compact(schema.items)}]`;
  if (schema.type === 'object') {
    const required = schema.required || [];
    return `{${Object.entries(schema.properties || {}).map(([key, value]) => `${key}${required.includes(key) ? '' : '?'}:${compact(value)}`).join(',')}}`;
  }
  return schema.type || 'value';
}
const actionKey = selector => Object.entries(selector).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}`).join('|');
const selectorFor = action => Object.fromEntries(Object.entries(action).filter(([key]) =>
  ['type', ...(action.type === 'app_tool' ? ['tool'] : action.type === 'query' ? ['topic'] : action.type === 'navigate' ? ['destination'] : [])].includes(key)));

class SkillTool {
  constructor(manager, manifest) { this.manager = manager; this.manifest = manifest; }
  get spec() {
    const { name, description, inputSchema } = this.manifest;
    return { name, description, parameters: z.toJSONSchema(inputSchema, { io: 'input', unrepresentable: 'any' }) };
  }
  invoke(args, groups) {
    const manifest = this.manifest;
    if (!groups.includes(manifest.group)) throw new Error('Skill outside selected catalog');
    const input = manifest.inputSchema.parse(args);
    return { action: { ...input, ...manifest.selector }, instructions: this.manager.instructions(manifest.name),
      metadata: { skill: manifest.name, version: manifest.version, group: manifest.group, kind: 'preview' } };
  }
}

class SkillManager {
  constructor(directory) {
    this.directory = fs.realpathSync(directory);
    this.manifests = new Map(); this.actions = new Map(); this.bodies = new Map(); this.groups = {};
    for (const groupEntry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!groupEntry.isDirectory()) continue;
      const groupPath = path.join(directory, groupEntry.name), infoPath = path.join(groupPath, 'group.json');
      if (!fs.existsSync(infoPath)) continue;
      const group = z.object({ name: identifier, description: z.string().min(1).max(500) }).strict().parse(JSON.parse(fs.readFileSync(infoPath, 'utf8')));
      if (group.name !== groupEntry.name || own(this.groups, group.name)) throw new Error('Invalid skill group');
      this.groups[group.name] = { description: group.description, types: [], queries: [], screens: [], tools: [], context: { medication: false, profile: false } };
      for (const entry of fs.readdirSync(groupPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const file = path.join(groupPath, entry.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        if (fs.lstatSync(file).isSymbolicLink() || !fs.realpathSync(file).startsWith(this.directory + path.sep)) throw new Error('Skill path outside trusted directory');
        const { header } = splitDocument(fs.readFileSync(file, 'utf8'));
        const parsed = frontmatterSchema.parse(YAML.parse(header, { maxAliasCount: 0, uniqueKeys: true }));
        const meta = parsed.metadata.asinu;
        if (parsed.name !== entry.name || meta.group !== group.name || this.manifests.has(parsed.name)) throw new Error('Invalid or duplicate skill');
        const key = actionKey(meta.selector);
        if (this.actions.has(key)) throw new Error('Capability belongs to multiple skills');
        const manifest = { name: parsed.name, description: parsed.description, group: group.name, version: meta.version,
          selector: Object.freeze(meta.selector), context: Object.freeze(meta.context), file, headerHash: digest(header), inputSchema: argumentsSchema(meta.selector) };
        this.manifests.set(manifest.name, manifest); this.actions.set(key, manifest);
        const definition = this.groups[group.name], selector = meta.selector;
        if (selector.type === 'app_tool') definition.tools.push(selector.tool);
        else if (selector.type === 'query') definition.queries.push(selector.topic);
        else if (selector.type === 'navigate') definition.screens.push(selector.destination);
        else definition.types.push(selector.type);
        for (const key of ['medication', 'profile']) definition.context[key] ||= meta.context[key];
      }
    }
  }
  list(groups = Object.keys(this.groups)) {
    return [...this.manifests.values()].filter(manifest => groups.includes(manifest.group)).map(({ name, description, group, version }) => ({ name, description, group, version }));
  }
  tool(name) {
    if (typeof name !== 'string' || !this.manifests.has(name)) throw new Error('Unknown assistant skill');
    return new SkillTool(this, this.manifests.get(name));
  }
  forAction(action) {
    const result = this.actions.get(actionKey(selectorFor(action)));
    if (!result) throw new Error('Unsupported skill capability');
    return result;
  }
  callForAction(action) {
    const manifest = this.forAction(action);
    return { name: manifest.name, arguments: Object.fromEntries(Object.entries(action).filter(([key]) => !own(manifest.selector, key))) };
  }
  decode(raw, groups, request) {
    if (!Object.hasOwn(raw, 'calls')) return raw; // Older provider output still passes the same strict validators.
    const value = z.object({ status: z.enum(['ready', 'clarify', 'unsupported']), question: z.string().max(2000).default(''),
      calls: z.array(z.object({ name: identifier, arguments: z.record(z.string(), z.unknown()) }).strict()).max(5),
    }).strict().parse(raw);
    if (value.status !== 'ready' && value.calls.length) throw new Error('Partial skill request');
    return { status: value.status, question: value.question, actions: value.calls.map(call => {
      const manifest = this.tool(call.name).manifest;
      if (!groups.includes(manifest.group)) throw new Error('Skill outside selected catalog');
      let args = call.arguments;
      // Provenance is server-owned, not a model-rewritten quotation. The clock
      // helper alone needs an exact task segment so mixed commands stay separate.
      if (request && manifest.selector.type !== 'routine_reminders') {
        const source = [request.clarification?.original, request.text].filter(Boolean).join('\n');
        if (source.length <= 3000) args = { ...args, evidence: source };
      }
      return { ...manifest.inputSchema.parse(args), ...manifest.selector };
    }) };
  }
  instructions(name) {
    const manifest = this.tool(name).manifest;
    if (!this.bodies.has(name)) {
      if (fs.lstatSync(manifest.file).isSymbolicLink() || !fs.realpathSync(manifest.file).startsWith(this.directory + path.sep)) throw new Error('Skill path outside trusted directory');
      const { header, body } = splitDocument(fs.readFileSync(manifest.file, 'utf8'));
      if (digest(header) !== manifest.headerHash || !body) throw new Error('Skill changed after catalog discovery');
      this.bodies.set(name, body);
    }
    return this.bodies.get(name);
  }
  catalog(groups, { requireEvidence = false } = {}) {
    const items = this.list(groups).map(item => {
      const manifest = this.manifests.get(item.name);
      const schema = this.tool(item.name).spec.parameters;
      if (!requireEvidence && manifest.selector.type !== 'routine_reminders') {
        delete schema.properties.evidence;
        schema.required = (schema.required || []).filter(key => key !== 'evidence');
      }
      if (schema.properties.parameters?.type === 'object' && !Object.keys(schema.properties.parameters.properties || {}).length && !schema.required.includes('parameters'))
        delete schema.properties.parameters;
      return { ...item, description: manifest.description, shape: compact(schema) };
    });
    const aliases = new Map();
    for (const item of items) if (item.shape.length > 50 && items.filter(other => other.shape === item.shape).length > 1 && !aliases.has(item.shape))
      aliases.set(item.shape, `Input${aliases.size + 1}`);
    return [...aliases].map(([shape, alias]) => `${alias}=${shape}`).concat(items.map(item =>
      `${item.name}${item.shape === '{}' ? '' : ` ${aliases.get(item.shape) || item.shape}`}: ${item.description}`)).join('\n');
  }
  invoke(actions, groups) {
    return actions.map(action => {
      const call = this.callForAction(action);
      return this.tool(call.name).invoke(call.arguments, groups);
    });
  }
}
module.exports = { SkillManager, SkillTool, argumentsSchema };
