import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'grokbot-tasks-'));
Object.assign(process.env,{DB_PATH:join(dir,'db'),COMPOSIO_API_KEY:'test',DESKTOP_TOKEN:'test',SESSION_SECRET:'test',LLM_API_KEY:'test'});
const realFetch=globalThis.fetch;globalThis.fetch=()=>Promise.resolve(new Response('{}',{status:401}));
const {db}=await import('../server/src/db.ts');
const {initSubagents}=await import('../server/src/agent/subagents.ts');initSubagents();
const {api}=await import('../server/src/routes.ts');
const {toolMap}=await import('../server/src/agent/tools.ts');
const {systemPrompt}=await import('../server/src/agent/prompt.ts');
for(const id of ['owner','other']){
 db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run(id,`${id}@test.invalid`,id);
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,0,?)').run(id,id,Date.now()+100000);
 db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run(id,id,id);
}
db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES ('task1','owner','Finished review','working',0,0)").run();
const ctx={botId:'owner',userId:'owner',depth:0,enqueueBotMessage:()=>{}};
test('open task IDs and settlement instructions are visible to the agent',async()=>{
 const prompt=await systemPrompt('owner','owner');assert.match(prompt,/task1/);assert.match(prompt,/update_task/);
 assert.ok(toolMap.has('list_tasks'));
});
test('owner can settle/reopen tasks, invalid and cross-owner changes are rejected',async()=>{
 const req=(user,state)=>api.request('/tasks/task1',{method:'PATCH',headers:{cookie:`grokbot_session=${user}`,'content-type':'application/json'},body:JSON.stringify({state})});
 assert.equal((await req('other','done')).status,404);
 assert.equal((await req('owner','invalid')).status,400);
 assert.equal((await req('owner','done')).status,200);
 assert.equal(db.prepare("SELECT state FROM tasks WHERE id='task1'").get().state,'done');
 assert.equal((await req('owner','working')).status,200);
 const result=await toolMap.get('update_task').impl({task_id:'not-found',state:'done'},ctx);
 assert.match(result.output,/not found/i);
});
after(()=>{globalThis.fetch=realFetch;db.close();rmSync(dir,{recursive:true,force:true});});
