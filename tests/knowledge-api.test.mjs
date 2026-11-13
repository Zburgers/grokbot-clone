import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
const dir = mkdtempSync(join(tmpdir(), 'grokbot-knowledge-api-'));
const config = join(dir, 'knowledge.json');
writeFileSync(config, JSON.stringify({ sources: [], devices: [{ id: 'test', label: 'Fixture', url: 'http://127.0.0.1:3773/mcp' }], grants: { a: { sources: [], devices: ['test'] } } }));
Object.assign(process.env, { DB_PATH: join(dir, 'test.db'), GROKBOT_KNOWLEDGE_CONFIG: config, COMPOSIO_API_KEY: 'test', DESKTOP_TOKEN: 'test', SESSION_SECRET: 'test', LLM_API_KEY: 'test' });
const { db } = await import('../server/src/db.ts');
const { initSubagents } = await import('../server/src/agent/subagents.ts'); initSubagents();
for (const id of ['u', 'other']) {
 db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run(id, `${id}@test.invalid`, id);
 db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,0,?)').run(id, id, Date.now() + 60000);
}
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run('a', 'u', 'Bot');
const { api } = await import('../server/src/routes.ts');
const { configApi } = await import('../server/src/routes-config.ts');
const { saveMemory } = await import('../server/src/bot-memory.ts');
const app = new Hono().route('/api', api).route('/api', configApi);
const request = (path, method = 'GET', body, user = 'u') => app.request(`/api${path}`, { method, headers: { cookie: `grokbot_session=${user}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('connection credentials are owner-scoped, validated, write-only and atomically persisted', async () => {
 const path = '/bots/a/mcp/test/token';
 assert.equal((await request(path, 'POST', { token: 'fixture-new-token' }, '')).status, 401);
 assert.equal((await request(path, 'POST', { token: 'fixture-new-token' }, 'other')).status, 404);
 assert.equal((await request(path, 'POST', { token: '\ninvalid' })).status, 400);
 assert.equal((await request(path, 'POST', { token: 'fixture-new-token' })).status, 200);
 assert.equal(JSON.parse(readFileSync(config, 'utf8')).devices[0].token, 'fixture-new-token');
 const response = await request('/bots/a/settings');
 const text = await response.text();
 assert.ok(!text.includes('fixture-new-token'));
 assert.match(text, /configured/);
 assert.equal((await request('/bots/a/mcp/not-assigned/test', 'POST')).status, 403);
});
test('memory edit and forget APIs exclude superseded versions and reject cross-owner changes', async () => {
 const old = saveMemory('a', 'Old memory');
 assert.equal((await request(`/memories/${old.id}`, 'PATCH', { text: 'Corrected memory' }, 'other')).status, 404);
 assert.equal((await request(`/memories/${old.id}`, 'PATCH', { text: '' })).status, 400);
 const response = await request(`/memories/${old.id}`, 'PATCH', { text: 'Corrected memory' });
 assert.equal(response.status, 200);
 const { memory } = await response.json();
 const list = await (await request('/bots/a/memories')).json();
 assert.deepEqual(list.memories.map(m => m.text), ['Corrected memory']);
 assert.equal((await request(`/memories/${memory.id}`, 'DELETE')).status, 200);
 assert.deepEqual((await (await request('/bots/a/memories')).json()).memories, []);
 assert.equal(db.prepare('SELECT status FROM memories WHERE id=?').get(memory.id).status, 'forgotten');
});
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
