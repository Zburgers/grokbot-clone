import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'grokbot-knowledge-'));
const root = join(dir, 'memory');
mkdirSync(join(root, 'rollout_summaries'), { recursive: true });
writeFileSync(join(root, 'memory_summary.md'), '# Knowledge\nThe migration uses the blue interface.');
writeFileSync(join(root, 'rollout_summaries', 'migration.md'), '# Migration\nPreserve legacy migration workflows.');
writeFileSync(join(dir, 'private.md'), 'DO NOT READ');
symlinkSync(join(dir, 'private.md'), join(root, 'rollout_summaries', 'escape.md'));
const config = join(dir, 'knowledge.json');
writeFileSync(config, JSON.stringify({ sources: [{ id: 'codex', label: 'Codex memory', root, files: ['memory_summary.md', 'rollout_summaries/*.md'] }], devices: [{ id: 'local', label: 'Local T3', url: 'http://127.0.0.1:3773/mcp', token: 'test-secret' }], grants: { parent: { sources: ['codex'], devices: ['local'] } } }));
Object.assign(process.env, { DB_PATH: join(dir, 'test.db'), COMPOSIO_API_KEY: 'test', DESKTOP_TOKEN: 'test', SESSION_SECRET: 'test', LLM_API_KEY: 'test', GROKBOT_KNOWLEDGE_CONFIG: config });
const { db } = await import('../server/src/db.ts');
const { initSubagents } = await import('../server/src/agent/subagents.ts');
initSubagents();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run('owner', 'owner@test.invalid', 'Owner');
for (const id of ['parent', 'child', 'other']) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run(id, 'owner', id);
db.prepare('UPDATE bots SET parent_bot_id=?, hidden=1 WHERE id=?').run('parent', 'child');
const policy = await import('../server/src/knowledge-policy.ts').catch(() => ({}));
const knowledge = await import('../server/src/codex-memory.ts').catch(() => ({}));

test('knowledge access is explicit, owner-checked and inherited only from a real parent', () => {
  assert.equal(typeof policy.knowledgeAccess, 'function');
  assert.deepEqual(policy.knowledgeAccess('owner', 'other'), { sources: [], devices: [] });
  assert.throws(() => policy.knowledgeAccess('wrong-owner', 'parent'), /denied/i);
  assert.deepEqual(policy.knowledgeAccess('owner', 'child'), policy.knowledgeAccess('owner', 'parent'));
  assert.throws(() => policy.allowedDevice('owner', 'other', 'local'), /denied/i);
  assert.equal(policy.allowedDevice('owner', 'parent', 'local').url, 'http://127.0.0.1:3773/mcp');
  assert.ok(!JSON.stringify(policy.knowledgeAccess('owner', 'parent')).includes('test-secret'));
  db.prepare('UPDATE bots SET parent_bot_id=? WHERE id=?').run('child', 'parent');
  assert.throws(() => policy.knowledgeAccess('owner', 'child'), /denied/i);
  db.prepare('UPDATE bots SET parent_bot_id=NULL WHERE id=?').run('parent');
});

test('Codex search retrieves bounded historical evidence with provenance', async () => {
  assert.equal(typeof knowledge.searchCodexMemory, 'function');
  const results = await knowledge.searchCodexMemory('owner', 'child', 'migration');
  assert.ok(results.length >= 1);
  assert.ok(results.some(r => r.path === 'rollout_summaries/migration.md'));
  assert.ok(results.every(r => r.source === 'codex' && r.modifiedAt && r.text.length <= 4000));
  assert.ok(!JSON.stringify(results).includes('DO NOT READ'));
  assert.deepEqual(await knowledge.searchCodexMemory('owner', 'other', 'migration'), []);
});

test('Codex reading rejects traversal, private files, symlinks and unapproved sources', async () => {
  assert.equal(typeof knowledge.readCodexMemory, 'function');
  for (const path of ['../private.md', '/etc/passwd', '.git/config', 'rollout_summaries/escape.md']) {
    await assert.rejects(() => knowledge.readCodexMemory('owner', 'parent', 'codex', path), /denied|unavailable/i);
  }
  await assert.rejects(() => knowledge.readCodexMemory('owner', 'other', 'codex', 'memory_summary.md'), /denied/i);
  const excerpt = await knowledge.readCodexMemory('owner', 'child', 'codex', 'memory_summary.md');
  assert.match(excerpt.text, /blue interface/);
});

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
