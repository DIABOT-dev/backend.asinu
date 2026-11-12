'use strict';
jest.mock('../../src/services/ai/ai.service',()=>({callTextAi:jest.fn()}));
const {callTextAi}=require('../../src/services/ai/ai.service');
const {initialize,refreshCoverage,impactMeaning}=require('../../src/services/checkin/compact-coverage.service');
const {getCompactNextStep}=require('../../src/services/checkin/compact-interview.service');
const {resolveComplaint}=require('../../src/services/checkin/clinical-mapping');

function scene(answer){
 const q={step:'compact_clinical_context',field:'clinical_context',layout:'eight_groups',shared:true,
  targets:[],clinicalParts:['medication_today'],question:'Hôm nay anh dùng thuốc như thế nào?',choices:[]};
 const compact={version:2,layout:'eight_groups',lang:'vi',hasConditions:false,questions:[q]};
 const ledger=initialize(compact);
 ledger.concerns=[{id:'c1',label:'đau nhức khớp',region:'limbs',evidence:{answerIndex:0,quote:'đau nhức khớp'},detailFields:['character'],
  facts:{location:{value:'cổ chân/bàn chân phải',status:'reported'},onset:{value:'Dưới 1 ngày',status:'reported'},progression:{value:'Vẫn như cũ',code:'same',status:'reported'},character:{value:'âm ỉ',status:'reported'}}}];
 ledger.nextConcernId=2;ledger.global.symptoms={value:'đau nhức khớp',status:'reported'};
 const input={lang:'vi',phase:'initial',status:'tired',profile:{age:35,gender:'Nam'},bodyLocations:['limbs'],bodyLocationOther:'Tay chân: cổ chân/bàn chân phải',
  healthContext:{},previousAnswers:[{step:q.step,question:q.question,answer}],adaptiveState:{version:1,sources:[],questions:[],compact}};
 return {compact,ledger,input};
}
beforeEach(()=>jest.clearAllMocks());
const respondWith=extraction=>callTextAi.mockImplementation(async params=>({content:JSON.stringify(params.system.startsWith('Review')?{valid:true,errors:[]}:extraction)}));

test('the video answer remains a detail of the known ankle complaint, without a new headache or new timelines',async()=>{
 const answer='Đau lắm cứ tức tức ko đi đc.';const s=scene(answer);
 respondWith({new_concerns:[
  {id:'new_1',label:'Đau',quote:'Đau',answer_index:0,region:null,detail_fields:['character']},
  {id:'new_2',label:'tức tức',quote:'tức tức',answer_index:0,region:null,detail_fields:['character']},
 ],facts:[],global_answer:{relevant:false},shared_facts:[
  {field:'impact',code:'unable',value:'ko đi đc',quote:'ko đi đc',answer_index:0},
 ]});
 await refreshCoverage(s.compact,s.input);
 expect(s.ledger.concerns).toHaveLength(1);
 expect(s.ledger.concerns[0].facts.character.value).toBe('tức tức');
 expect(s.ledger.concerns[0].facts.onset.value).toBe('Dưới 1 ngày');
 expect(s.ledger.concerns[0].facts.progression.code).toBe('same');
 expect(s.ledger.global.impact).toMatchObject({code:'unable',status:'reported',value:'ko đi đc'});
 expect(s.ledger.global.medication_today.status).toBe('unresolved');
 expect(getCompactNextStep(s.input).state.mappings).not.toContain(resolveComplaint('đau đầu').data);
});

test('an explicitly new painful body site remains new instead of being merged with the ankle',async()=>{
 const s=scene('Ngoài ra tôi còn đau ở bụng bên phải từ sáng nay');
 respondWith({new_concerns:[{id:'new_1',label:'đau',quote:'đau',answer_index:0,region:null,detail_fields:[]}],
  facts:[{concern_id:'new_1',field:'location',value:'bụng bên phải',quote:'bụng bên phải',answer_index:0},
   {concern_id:'new_1',field:'onset',value:'sáng nay',quote:'sáng nay',answer_index:0}],global_answer:{relevant:false}});
 await refreshCoverage(s.compact,s.input);
 expect(s.ledger.concerns).toHaveLength(2);
 expect(s.ledger.concerns[0].facts.location.value).toBe('cổ chân/bàn chân phải');
 expect(s.ledger.concerns[1].facts.location.value).toBe('bụng bên phải');
 expect(getCompactNextStep(s.input).state.mappings).toContain(resolveComplaint('đau bụng').data);
});

test('an ambiguous generic pain is not assigned to either of two existing pain sites',async()=>{
 const s=scene('Đau lắm');
 s.ledger.concerns.push({...structuredClone(s.ledger.concerns[0]),id:'c2',label:'đau bụng',region:'abdomen'});s.ledger.nextConcernId=3;
 respondWith({new_concerns:[{id:'new_1',label:'Đau',quote:'Đau',answer_index:0,region:null,detail_fields:[]}],facts:[],global_answer:{relevant:false}});
 await refreshCoverage(s.compact,s.input);
 expect(s.ledger.concerns).toHaveLength(3);
 expect(s.ledger.concerns[2]).toMatchObject({label:'Đau',region:null});
});

test('a separately known tightness complaint is not reassigned to the pain complaint',async()=>{
 const s=scene('tức tức càng bó chặt');
 s.ledger.concerns.push({id:'c2',label:'tức tức',region:'limbs',evidence:{answerIndex:0,quote:'tức tức'},detailFields:['character'],facts:{}});s.ledger.nextConcernId=3;
 respondWith({new_concerns:[{id:'new_1',label:'tức tức',quote:'tức tức',answer_index:0,region:null,detail_fields:[]}],
  facts:[{concern_id:'new_1',field:'character',value:'càng bó chặt',quote:'càng bó chặt',answer_index:0}],global_answer:{relevant:false}});
 await refreshCoverage(s.compact,s.input);
 expect(s.ledger.concerns).toHaveLength(2);
 expect(s.ledger.concerns[0].facts.character.value).toBe('âm ỉ');
 expect(s.ledger.concerns[1].facts.character.value).toBe('càng bó chặt');
});

test.each(['ko đi đc','ko đi dc','khong đi được','không đi được'])(
 'common typed/speech spelling still grounds the actual inability to walk: %s',value=>{
  expect(impactMeaning(value)).toBe('unable');
 });
