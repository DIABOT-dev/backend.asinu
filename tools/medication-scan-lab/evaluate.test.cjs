'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('./evaluate.cjs');
const truth = { expectedReadable: true, expectedKind: 'MEDICINE', expectedNameAliases: ['amlor'], expectedUniqueItems: 1 };
const sample = () => ({ readable: true, document_type: 'PACKAGING',
  items: [{ printed_name: 'AMLOR', display_name: 'AMLOR', kind: 'MEDICINE', suggested_slots: [] }], uncertain: [] });
test('accepts a grounded packaging name, including fenced JSON returned by provider', () => {
  assert.equal(evaluate('```json\n'+JSON.stringify(sample())+'\n```', truth).passed, true);
});
test('unknown importer-only side is successful only when the model abstains', () => {
  const unknown = { expectedReadable: false, expectedNameAliases: [], expectedUniqueItems: 0 };
  assert.equal(evaluate(JSON.stringify({ readable:false,document_type:'PACKAGING',items:[],uncertain:[] }), unknown).passed, true);
  assert.equal(evaluate(JSON.stringify(sample()), unknown).passed, false);
});
test('an empty product list is a safe abstention, but readable=true remains a schema error', () => {
  const result=evaluate(JSON.stringify({readable:true,document_type:'PACKAGING',items:[],uncertain:[]}),
    {expectedReadable:false,expectedNameAliases:[],expectedUniqueItems:0});
  assert.equal(result.nameCorrect,true);assert.equal(result.abstentionCorrect,true);
  assert.equal(result.schemaValid,false);assert.deepEqual(result.reasons,['invalid_schema']);
});
test('duplicate product items cannot inflate the recognition rate', () => {
  const a=sample();a.items.push({...a.items[0]});
  assert.equal(evaluate(JSON.stringify(a),truth).countCorrect,false);
});
test('does not accept an incorrect brand or accept a dose as part of the printed name', () => {
  const a=sample();a.items[0].printed_name='Concor';
  assert.equal(evaluate(JSON.stringify(a),truth).nameCorrect,false);
  a.items[0].printed_name='AMLOR 5 mg';
  assert.equal(evaluate(JSON.stringify(a),truth).noDose,false);
});
test('rejects hidden dosage fields, additional schema fields and invented slots', () => {
  const a=sample();a.items[0].dosage='1 tablet';a.items[0].suggested_slots=['after_breakfast'];
  const result=evaluate(JSON.stringify(a),truth);
  assert.equal(result.schemaValid,false);assert.equal(result.noDose,false);assert.equal(result.noInventedSchedule,false);
});
test('does not confuse vitamin identity D3/B12 or Omega-3 with medication strength', () => {
  const a=sample();a.items[0].printed_name='Vitamin D3 B12 Omega-3';
  assert.equal(evaluate(JSON.stringify(a),truth).noDose,true);
});
test('does not score invalid JSON or nonarray items as successful recognition', () => {
  assert.equal(evaluate('not JSON',truth).passed,false);
  assert.equal(evaluate('null',truth).passed,false);
  const malformed=sample();malformed.items=[null];
  assert.equal(evaluate(JSON.stringify(malformed),truth).passed,false);
  const a=sample();a.items={};assert.equal(evaluate(JSON.stringify(a),truth).passed,false);
});
test('a display name over 30 characters or unknown kind does not pass full acceptance', () => {
  const a=sample();a.items[0].display_name='a'.repeat(31);a.items[0].kind='UNKNOWN';
  const result=evaluate(JSON.stringify(a),truth);
  assert.equal(result.schemaValid,false);assert.equal(result.typeCorrect,false);
});
