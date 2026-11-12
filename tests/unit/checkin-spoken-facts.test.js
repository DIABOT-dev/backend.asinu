'use strict';
jest.mock('../../src/services/ai/ai.service', () => ({ callTextAi: jest.fn() }));
const { validateExtraction, initialize, refreshCoverage } = require('../../src/services/checkin/compact-coverage.service');
const { callTextAi } = require('../../src/services/ai/ai.service');

const contextFor = answer => ({ field:'symptoms',answer_index:0,answer,concerns:[],
  locations:['skin'],exact_location:'Da: vùng cổ',eight_group_interview:true });
const complaint = (id,label,region=null) => ({id,label,quote:label,answer_index:0,region,detail_fields:[]});
const fact = (concern_id,field,value) => ({concern_id,field,value,quote:value,answer_index:0});

test('one real Dr7 speech extraction preserves three complaints and their own dates without inventing measurement status',()=>{
 const answer='Da cổ tôi ngứa từ tối qua, còn bụng dưới bên phải đau âm ỉ từ sáng nay. Đầu hơi choáng khi đứng dậy từ trưa, nhưng tôi không sốt và không khó thở. Hôm nay tôi đã uống thuốc huyết áp đúng giờ.';
 const value={new_concerns:[complaint('new_1','ngứa','skin'),complaint('new_2','đau âm ỉ'),complaint('new_3','hơi choáng')],
  facts:[fact('new_1','location','Da cổ'),fact('new_1','onset','tối qua'),fact('new_2','location','bụng dưới bên phải'),fact('new_2','onset','sáng nay'),fact('new_3','onset','từ trưa')],
  shared_facts:[{field:'measurements_today',code:'not_measured',value:'không sốt',quote:'không sốt',answer_index:0},
   {field:'medication_today',code:'medication_as_planned',value:'đã uống thuốc huyết áp đúng giờ',quote:'đã uống thuốc huyết áp đúng giờ',answer_index:0}]};
 const result=validateExtraction(JSON.stringify(value),contextFor(answer));
 expect(result.new_concerns.map(c=>c.label)).toEqual(['ngứa','đau âm ỉ','hơi choáng']);
 expect(result.facts.filter(f=>f.field==='onset').map(f=>[f.concern_id,f.value])).toEqual([['new_1','tối qua'],['new_2','sáng nay'],['new_3','từ trưa']]);
 expect(result.shared_facts.map(f=>f.field)).toEqual(['medication_today']);
});

test('grounded negative auxiliary facts do not discard the actual current complaint or turn an old resolved symptom into a new one',()=>{
 const answer='Tuần trước tôi có đau đầu nhưng đã hết. Hôm nay da hai cẳng chân ngứa râm ran từ sáng, không đau bụng, không sốt. Tôi quên thuốc huyết áp sáng nay.';
 const value={new_concerns:[complaint('new_1','ngứa râm ran','skin')],
  facts:[fact('new_1','location','hai cẳng chân'),fact('new_1','onset','từ sáng'),fact('new_1','associated_symptoms','không đau bụng'),fact('new_1','associated_symptoms','không sốt')],
  shared_facts:[{field:'medication_today',code:'medication_issue',value:'quên thuốc huyết áp sáng nay',quote:'Tôi quên thuốc huyết áp sáng nay.',answer_index:0}]};
 const result=validateExtraction(JSON.stringify(value),contextFor(answer));
 expect(result.new_concerns.map(c=>c.label)).toEqual(['ngứa râm ran']);
 expect(result.facts.map(f=>f.field)).toEqual(['location','onset']);
 expect(result.shared_facts[0].code).toBe('medication_issue');
});

test('an unsupported positive auxiliary complaint is not silently discarded',()=>{
 const answer='Ngứa và khó thở';
 const value={new_concerns:[complaint('new_1','Ngứa','skin')],facts:[fact('new_1','associated_symptoms','khó thở')]};
 expect(validateExtraction(JSON.stringify(value),contextFor(answer))).toBeNull();
});

test('a mixed spoken impact reply adds the new complaint without copying the whole reply into the older complaint',async()=>{
 const answer='Tôi vẫn sinh hoạt bình thường, nhưng sáng nay đau bụng bên phải';
 callTextAi.mockImplementation(async params=>({content:JSON.stringify(params.system.startsWith('Review')
  ? {valid:true,errors:[]}
  : {new_concerns:[complaint('new_1','đau bụng bên phải')],facts:[fact('new_1','onset','sáng nay')],
    global_answer:{relevant:true,quote:'Tôi vẫn sinh hoạt bình thường'},
    shared_facts:[{field:'impact',code:'normal',value:'sinh hoạt bình thường',quote:'Tôi vẫn sinh hoạt bình thường',answer_index:0}]})}));
 const question={step:'compact_impact',field:'impact',shared:true,targets:['c1'],question:'Ngứa ảnh hưởng sinh hoạt thế nào?',choices:[]};
 const compact={version:2,layout:'eight_groups',lang:'vi',hasConditions:false,questions:[question]};
 const ledger=initialize(compact);
 ledger.concerns=[{id:'c1',label:'ngứa da cổ',region:'skin',evidence:{answerIndex:0,quote:'ngứa da cổ'},detailFields:[],facts:{onset:{value:'tối qua',status:'reported'}}}];ledger.nextConcernId=2;
 await refreshCoverage(compact,{lang:'vi',bodyLocations:['skin'],bodyLocationOther:'Da: cổ',healthContext:{},
  previousAnswers:[{step:question.step,question:question.question,answer}]});
 expect(ledger.concerns.map(c=>c.label)).toEqual(['ngứa da cổ','đau bụng bên phải']);
 expect(ledger.concerns[0].facts.onset.value).toBe('tối qua');
 expect(ledger.concerns[0].facts.impact).toBeUndefined();
 expect(ledger.concerns[1].facts.onset.value).toBe('sáng nay');
 expect(ledger.global.impact.code).toBe('normal');
});

test.each(['không sốt','không buồn nôn','đã uống thuốc','ngủ không ngon'])(
 'unrelated patient words cannot establish an absent measurement: %s',value=>{
  const result=validateExtraction(JSON.stringify({new_concerns:[],facts:[],shared_facts:[
   {field:'measurements_today',code:'not_measured',value,quote:value,answer_index:0},
  ]}),contextFor(value));
  expect(result.shared_facts).toEqual([]);
 });

test.each([
 ['chưa đo huyết áp hôm nay','not_measured'],
 ['đã đo huyết áp hôm nay','reading_available'],
 ['Huyết áp 128/78 mmHg','reading_available'],
 ['Đường huyết 118 mg/dL','reading_available'],
])('explicit measurement evidence still survives extraction: %s',(value,code)=>{
 const result=validateExtraction(JSON.stringify({new_concerns:[],facts:[],shared_facts:[
  {field:'measurements_today',code,value,quote:value,answer_index:0},
 ]}),contextFor(value));
 expect(result.shared_facts[0]).toMatchObject({code,value});
});
