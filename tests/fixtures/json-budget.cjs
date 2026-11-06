const {withinJsonBudget}=require(process.cwd()+'/src/security/json-budget');
const {patchSchema}=require(process.cwd()+'/src/services/onboarding/guidance.service');
const input={epoch:0,completed:Array(300000).fill(null)};
const start=Date.now();
if(withinJsonBudget(input))throw Error('Oversized input reached validation');
const result=patchSchema.safeParse(input);
if(result.success||result.error.issues.length>2)throw Error('Zod expanded invalid array errors');
console.log(JSON.stringify({rejected:true,issues:result.error.issues.length,elapsedMs:Date.now()-start}));
