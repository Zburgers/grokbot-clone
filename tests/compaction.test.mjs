import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'grokbot-compaction-'));
let fail = false;
const summaryRequests = [];
const endpoint = createServer(async (req, res) => {
 let raw = ''; for await (const part of req) raw += part;
 summaryRequests.push(JSON.parse(raw));
 res.setHeader('content-type', 'application/json');
 if (fail) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Fixture summary failure' } })); }
 return res.end(JSON.stringify({ id: 'summary', object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'User goal: migrate the project. Keep the blue interface. Current task: verify migration.' }] }] }));
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
Object.assign(process.env, { DB_PATH: join(dir, 'test.db'), COMPOSIO_API_KEY: 'test', DESKTOP_TOKEN: 'test', SESSION_SECRET: 'test', LLM_API_KEY: 'test', LLM_BASE_URL: `http://127.0.0.1:${endpoint.address().port}/v1`, GROKBOT_COMPACT_TOKENS: '1000' });
const { db } = await import('../server/src/db.ts');
const store = await import('../server/src/store.ts');
const memory = await import('../server/src/agent/memory.ts');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run('u', 'u@test.invalid', 'Owner');
for (const id of ['success', 'failure', 'measured']) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run(id, 'u', id);
const history = () => Array.from({ length: 8 }, (_, i) => [{ role: 'user', content: `Migration turn ${i}: ${'project context '.repeat(100)}` }, { type: 'function_call', call_id: `call${i}`, name: 'shell', arguments: '{}' }, { type: 'function_call_output', call_id: `call${i}`, output: 'Verified migration' }, { role: 'assistant', content: 'Preserve blue interface' }]).flat();
test('compaction keeps recent paired tool history and persists the useful summary', async () => {
 const items = history(); store.appendHistory('success', items);
 const next = await memory.maybeCompact('success', items);
 assert.ok(next.length < items.length);
 assert.match(next[0].content, /blue interface/);
 const calls = new Set(next.filter(x => x.type === 'function_call').map(x => x.call_id));
 assert.ok(next.filter(x => x.type === 'function_call_output').every(x => calls.has(x.call_id)));
 assert.deepEqual(store.loadHistory('success'), next);
 assert.match(summaryRequests[0].input[0].content, /historical observations/i);
});

test('measured context usage survives process restart and invalidates after history replacement', () => {
 const items = [{role:'user',content:'Keep project context'}, {type:'reasoning',encrypted_content:'opaque'.repeat(5000)}, {role:'assistant',content:'Understood'}];
 store.appendHistory('measured', items);
 memory.noteUsage('measured', 100, items.length, {overheadChars:200});
 const before = memory.historySize('measured', items, 200);
 const script = 'const m=await import("./server/src/agent/memory.ts");const s=await import("./server/src/store.ts");console.log(m.historySize("measured",s.loadHistory("measured"),200));';
 const after = Number(execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e',script], {cwd:process.cwd(),env:process.env,encoding:'utf8'}).trim());
 assert.equal(after, before);
 db.prepare('UPDATE llm_items SET item=? WHERE bot_id=? AND idx=0').run(JSON.stringify({role:'user',content:'Replaced history of same length'}),'measured');
 assert.notEqual(memory.historySize('measured',store.loadHistory('measured'),200), before);
});
test('compaction never separates a server-side search from its completed response', () => {
 const items=[{role:'user',content:'x'.repeat(2000)}, {type:'web_search_call',id:'web1',payload:'x'.repeat(2000)}, {type:'message',role:'assistant',content:'Search completed'}, {type:'reasoning',encrypted_content:'opaque'}, {type:'message',role:'assistant',content:'New response'}];
 assert.equal(memory.pickSplit(items,2000,4),3);
});
test('failed compaction is persistent and oversized requests stop with a visible recovery instruction', async () => {
 assert.equal(typeof memory.assertContextBudget, 'function');
 const items = history(); store.appendHistory('failure', items); fail = true;
 try { assert.deepEqual(await memory.maybeCompact('failure', items), items); } finally { fail = false; }
 assert.ok(db.prepare('SELECT compact_error FROM memory_jobs WHERE bot_id=?').get('failure').compact_error);
 assert.throws(() => memory.assertContextBudget('failure', items), /summar|context|conversation/i);
 assert.deepEqual(store.loadHistory('failure'), items);
});
after(() => { endpoint.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
