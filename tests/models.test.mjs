import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'grokbot-models-'));
const calls=[];
let failCatalog=false;
const endpoint=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/v1/models' && failCatalog){res.statusCode=503;return res.end('{}');}
 if(req.url==='/v1/models')return res.end(JSON.stringify({object:'list',data:[{id:'model-a',object:'model'},{id:'model-b',object:'model'}]}));
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);calls.push(body);
 const output=[{type:'message',role:'assistant',content:[{type:'output_text',text:`Using ${body.model}`}]}];
 res.setHeader('content-type','text/event-stream');
 const event=(type,extra)=>res.write(`data: ${JSON.stringify({type,...extra})}\n\n`);
 event('response.output_text.delta',{delta:`Using ${body.model}`});
 event('response.output_item.done',{item:output[0]});
 event('response.completed',{response:{id:'r1',output,usage:{input_tokens:10}}});
 res.end();
});
const realFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>String(input?.url??input).includes('backend.composio.dev')
 ? Promise.resolve(new Response(JSON.stringify({error:{message:'Disabled in test'}}),{status:401,headers:{'content-type':'application/json'}}))
 : realFetch(input,init);
await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
Object.assign(process.env,{DB_PATH:join(dir,'test.db'),COMPOSIO_API_KEY:'test',DESKTOP_TOKEN:'test',SESSION_SECRET:'test',LLM_API_KEY:'test',LLM_BASE_URL:`http://127.0.0.1:${endpoint.address().port}/v1`,LLM_MODEL:'model-a'});
const {db}=await import('../server/src/db.ts');
const {initSubagents,createSubagent}=await import('../server/src/agent/subagents.ts');initSubagents();
const {api}=await import('../server/src/routes.ts');
const store=await import('../server/src/store.ts');
for(const id of ['owner','other']){
 db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run(id,`${id}@test.invalid`,id);
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,0,?)').run(id,id,Date.now()+100000);
}
const request=(path,method='GET',body,owner='owner')=>api.request(path,{method,headers:{cookie:`grokbot_session=${owner}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
let bot;
test('catalog requires auth and lists endpoint models with server default',async()=>{
 assert.equal((await api.request('/models')).status,401);
 const r=await request('/models');assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{models:['model-a','model-b'],defaultModel:'model-a'});
});
test('model selection persists, validates choices, resets, and respects ownership',async()=>{
 bot=(await (await request('/bots','POST',{name:'Model test'})).json()).bot;
 assert.equal(bot.model,'');
 let r=await request(`/bots/${bot.id}`,'PATCH',{model:'model-b'});assert.equal(r.status,200);
 assert.equal((await r.json()).bot.model,'model-b');
 assert.equal(store.getBot(bot.id).model,'model-b');
 assert.equal((await request(`/bots/${bot.id}`,'PATCH',{model:'nonexistent'})).status,400);
 assert.equal((await request(`/bots/${bot.id}`,'PATCH',{model:123})).status,400);
 assert.equal((await request(`/bots/${bot.id}`,'PATCH',{model:'model-a'},'other')).status,404);
 const child=createSubagent(bot.id,'A temporary goal');assert.equal(store.getBot(child.id).model,'model-b');
 r=await request(`/bots/${bot.id}`,'PATCH',{model:''});assert.equal((await r.json()).bot.model,'');
});
test('chat sends the selected model to the endpoint',async()=>{
 assert.equal((await request(`/bots/${bot.id}`,'PATCH',{model:'model-b'})).status,200);
 await request(`/bots/${bot.id}/messages`,'POST',{text:'Hello'});
 for(let i=0;i<100;i++){
  await new Promise(r=>setTimeout(r,20));
  if(!store.getLive(bot.id).isRunning && calls.length)break;
 }
 assert.equal(calls.at(-1)?.model,'model-b');
 const {rows}=await (await request(`/bots/${bot.id}/rows`)).json();
 assert.ok(rows.some(r=>r.body?.text==='Using model-b'));
 // Return history ownership to the default for the next switching test.
 store.prepareHistoryForModel(bot.id,'model-a');
});
test('model changes are blocked during a task',async()=>{
 store.setLive(bot.id,{isRunning:true});
 const r=await request(`/bots/${bot.id}`,'PATCH',{model:'model-a'});
 assert.equal(r.status,409);
 store.setLive(bot.id,{isRunning:false});
 assert.equal(store.getBot(bot.id).model,'model-b');
});
test('switching models removes opaque history but retains text and tool results',()=>{
 assert.equal(typeof store.prepareHistoryForModel,'function');
 store.appendHistory(bot.id,[{role:'user',content:'Keep this context'},{type:'reasoning',encrypted_content:'opaque'},{type:'function_call',call_id:'c1',name:'shell',arguments:'{}'},{type:'function_call_output',call_id:'c1',output:'retained'}]);
 const same=store.prepareHistoryForModel(bot.id,'model-a');assert.ok(same.some(i=>i.type==='reasoning'));
 const switched=store.prepareHistoryForModel(bot.id,'model-b');assert.ok(!switched.some(i=>i.type==='reasoning'));
 assert.ok(switched.some(i=>i.content==='Keep this context'));
 assert.ok(switched.some(i=>i.output==='retained'));
 assert.deepEqual(store.loadHistory(bot.id),switched);
});
test('catalog failure is explicit and does not erase saved choices',async()=>{
 failCatalog=true;
 try {
  assert.equal((await request('/models')).status,502);
  assert.equal((await request(`/bots/${bot.id}`,'PATCH',{model:'model-a'})).status,502);
  assert.equal(store.getBot(bot.id).model,'model-b');
  const same=await request(`/bots/${bot.id}`,'PATCH',{model:'model-b',label:'Still editable'});
  assert.equal(same.status,200);
  const reset=await request(`/bots/${bot.id}`,'PATCH',{model:''});assert.equal(reset.status,200);
 } finally {failCatalog=false;}
});
after(()=>{globalThis.fetch=realFetch;endpoint.close();db.close();rmSync(dir,{recursive:true,force:true});});
