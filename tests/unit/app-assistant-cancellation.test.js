'use strict';
jest.mock('../../src/services/assistant/app-assistant.service',()=>({plan:jest.fn()}));
jest.mock('../../src/services/ai/ai-consent.service',()=>({hasAiConsent:jest.fn().mockResolvedValue(true)}));
jest.mock('../../src/i18n',()=>({getLang:()=> 'vi',t:()=> 'message'}));
const {EventEmitter}=require('node:events');
const assistant=require('../../src/services/assistant/app-assistant.service');
const {hasAiConsent}=require('../../src/services/ai/ai-consent.service');
const controller=require('../../src/controllers/app-assistant.controller');
let req,res;
beforeEach(()=>{
  jest.clearAllMocks();
  req=Object.assign(new EventEmitter(),{body:{text:'synthetic request'},user:{id:7},aborted:false});
  res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,set:jest.fn(),status:jest.fn(),json:jest.fn()});
  res.set.mockReturnValue(res);res.status.mockReturnValue(res);
  res.json.mockImplementation(()=>{res.writableEnded=true;return res;});
});

test('client disconnect aborts its AI work and removes response listeners',async()=>{
  let signal;
  assistant.plan.mockImplementationOnce((_body,_lang,options)=>{
    signal=options.signal;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  const pending=controller.plan({},req,res);
  res.destroyed=true;res.emit('close');
  await pending;
  expect(signal.aborted).toBe(true);
  expect(res.json).not.toHaveBeenCalled();expect(hasAiConsent).not.toHaveBeenCalled();
  expect(req.listenerCount('aborted')).toBe(0);expect(res.listenerCount('close')).toBe(0);
});

test('an already disconnected request does not start a model plan',async()=>{
  req.aborted=true;
  await controller.plan({},req,res);
  expect(assistant.plan).not.toHaveBeenCalled();expect(res.json).not.toHaveBeenCalled();
});

test('normal success retains consent checks and does not cancel the finished request',async()=>{
  let signal;
  assistant.plan.mockImplementationOnce(async(_body,_lang,options)=>{signal=options.signal;return{status:'ready',actions:[]};});
  await controller.plan({},req,res);
  expect(hasAiConsent).toHaveBeenCalledWith({},7);
  expect(res.json).toHaveBeenCalledWith({ok:true,status:'ready',actions:[]});
  res.emit('close');expect(signal.aborted).toBe(false);
  expect(res.listenerCount('close')).toBe(0);
});
