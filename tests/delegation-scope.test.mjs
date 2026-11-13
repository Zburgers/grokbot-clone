import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'grokbot-delegation-'));
let write=false,mcpRequests=0;
const endpoint=createServer(async(req,res)=>{
 if(req.url==='/mcp'){mcpRequests++;res.statusCode=401;return res.end('{}');}
 let raw='';for await(const part of req)raw+=part;
 const body=JSON.parse(raw);
 const finished=body.input.some(i=>i.type==='function_call_output');
 const output=finished?[{type:'message',role:'assistant',content:[{type:'output_text',text:'Request handled.'}]}]:[{type:'function_call',name:'mcp_call',call_id:'scope-check',arguments:JSON.stringify({device:'local',tool:write?'t3_thread_send':'t3_environment_read',arguments:write?{threadId:'fixture',text:'test'}:{}})}];
 res.setHeader('content-type','text/event-stream');
 for(const item of output)res.write(`data: ${JSON.stringify({type:'response.output_item.done',item})}\n\n`);
 res.end(`data: ${JSON.stringify({type:'response.completed',response:{id:'scope-result',output,usage:{input_tokens:100}}})}\n\n`);
});
await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${endpoint.address().port}`;
const config=join(dir,'knowledge.json');
writeFileSync(config,JSON.stringify({sources:[],devices:[{id:'local',label:'Local',url:base+'/mcp',token:'fixture-token'}],grants:{a:{sources:[],devices:['local']}}}));
Object.assign(process.env,{DB_PATH:join(dir,'test.db'),GROKBOT_KNOWLEDGE_CONFIG:config,COMPOSIO_API_KEY:'test',DESKTOP_TOKEN:'test',SESSION_SECRET:'test',LLM_API_KEY:'test',LLM_BASE_URL:base+'/v1'});
const realFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>String(input?.url??input).includes('composio')?Promise.resolve(new Response('{}',{status:401,headers:{'content-type':'application/json'}})):realFetch(input,init);
const {db}=await import('../server/src/db.ts');
const {initSubagents}=await import('../server/src/agent/subagents.ts');initSubagents();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run('u','u@test.invalid','Owner');
for(const id of ['a','b'])db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run(id,'u',id);
const loop=await import('../server/src/agent/loop.ts');
const store=await import('../server/src/store.ts');
const waitIdle=async()=>{for(let i=0;i<300&&loop.isBotBusy('a');i++)await new Promise(r=>setTimeout(r,20));assert.equal(loop.isBotBusy('a'),false);};
const denied=()=>assert.ok(store.loadHistory('a').some(i=>i.type==='function_call_output'&&String(i.output).includes('Device access denied')));
test('Bot-message turn cannot use the recipient broader MCP grant',async()=>{
 loop.enqueue('a',{type:'bot',fromBotId:'b',fromName:'restricted',text:'Read the broader device',depth:1});
 await waitIdle();denied();assert.equal(mcpRequests,0);
});
test('owner approval does not erase the original resource scope when a delegated turn resumes',async()=>{
 store.clearConversation('a');write=true;
 loop.enqueue('a',{type:'bot',fromBotId:'b',fromName:'restricted',text:'Write on the broader device',depth:1});
 await waitIdle();
 const pending=db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get('a');
 assert.ok(pending);
 assert.ok(JSON.parse(pending.state).scopeBotIds.includes('b'));
 const approval=db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending'").get('a');
 loop.resolveApproval('u',approval.id,'allow');await waitIdle();
 denied();assert.equal(mcpRequests,0);
});
after(()=>{globalThis.fetch=realFetch;endpoint.close();db.close();rmSync(dir,{recursive:true,force:true});});
