const {spawnSync}=require('node:child_process');
const {withinJsonBudget,limitJsonComplexity}=require('../../src/security/json-budget');
test('large invalid collection is rejected within a 128 MiB child heap',()=>{
 const r=spawnSync(process.execPath,['--max-old-space-size=128','tests/fixtures/json-budget.cjs'],{encoding:'utf8',timeout:5000});
 expect(r.status).toBe(0);expect(JSON.parse(r.stdout)).toMatchObject({rejected:true,issues:1});
});
test('valid base64 uploads and existing 10,000-ID operations fit the input budget',()=>{
 expect(withinJsonBudget({ids:Array(10000).fill(1)})).toBe(true);
 expect(withinJsonBudget({data:'A'.repeat(14000000)})).toBe(true);
});
test('depth, object keys, and aggregate nesting cannot expand without limit',()=>{
 let deep={};for(let i=0;i<35;i++)deep={child:deep};
 expect(withinJsonBudget(deep)).toBe(false);
 expect(withinJsonBudget(Object.fromEntries(Array.from({length:1001},(_,i)=>['k'+i,1])))).toBe(false);
 expect(withinJsonBudget(Array.from({length:1000},()=>Array(30).fill(1)))).toBe(false);
});
test('middleware blocks oversized data before a controller or database runs',()=>{
 const next=jest.fn();limitJsonComplexity({body:{completed:Array(300000).fill(null)}},null,next);
 expect(next).toHaveBeenCalledWith(expect.objectContaining({statusCode:413,code:'INVALID_INPUT'}));
});
