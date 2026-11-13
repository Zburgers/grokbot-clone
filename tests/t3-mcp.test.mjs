import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const dir = mkdtempSync(join(tmpdir(), 'grokbot-mcp-'));
let requests = 0, rejectAuth = false;
let authorization;
const server = createServer(async (req, res) => {
  requests++;
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/oauth/mcp/')) {
    let raw = ''; for await (const part of req) raw += part;
    if (req.url.endsWith('/register')) return res.end(JSON.stringify({client_id:'fixture-client'}));
    if (req.url.endsWith('/decision')) {
      const body=JSON.parse(raw); authorization=body.authorization;
      if(body.decision.code!=='FIXTUREPAIR12'){res.statusCode=400;return res.end('{}');}
      return res.end(JSON.stringify({redirectTo:`${authorization.redirect_uri}?code=fixture-auth-code&state=${authorization.state}`}));
    }
    if(req.url.endsWith('/token')){
      const body=new URLSearchParams(raw);
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),authorization.code_challenge);
      return res.end(JSON.stringify({access_token:'fixture-token',token_type:'Bearer',expires_in:2592000,scope:'orchestration:read orchestration:operate'}));
    }
  }
  if (rejectAuth || req.headers.authorization !== 'Bearer fixture-token') { res.statusCode = 401; return res.end('{"error":"invalid_mcp_credential"}'); }
  if (req.method === 'DELETE') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('{}'); }
  let raw = ''; for await (const part of req) raw += part;
  const message = JSON.parse(raw);
  if (!('id' in message)) { res.statusCode = 202; return res.end(); }
  const result = value => res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }));
  if (message.method === 'initialize') return result({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock-t3', version: '1' } });
  if (message.method === 'tools/list') return result({ tools: [{ name: 't3_environment_read', description: 'Read server identity', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, {name:'delegate_task',description:'Thread-bound delegation',inputSchema:{type:'object',properties:{}}}] });
  if (message.method === 'tools/call') return result({ content: [{ type: 'text', text: 'Fixture identity' }] });
  return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const config = join(dir, 'knowledge.json');
writeFileSync(config, JSON.stringify({ sources: [], devices: [{ id: 'fixture', label: 'Test T3', url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'fixture-token' }], grants: { a: { sources: [], devices: ['fixture'] } } }));
Object.assign(process.env, { DB_PATH: join(dir, 'test.db'), GROKBOT_KNOWLEDGE_CONFIG: config, COMPOSIO_API_KEY: 'test', DESKTOP_TOKEN: 'test', SESSION_SECRET: 'test', LLM_API_KEY: 'test' });
const { db } = await import('../server/src/db.ts');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run('u', 'u@test.invalid', 'Owner');
for (const id of ['a', 'b']) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run(id, 'u', id);
const mcp = await import('../server/src/t3-mcp.ts').catch(() => ({}));
const pairing = await import('../server/src/t3-pairing.ts').catch(() => ({}));
test('native MCP initializes, discovers tools and invokes an authenticated read', async () => {
  assert.equal(typeof mcp.listMcpTools, 'function');
  const catalog = await mcp.listMcpTools('u', 'a', 'fixture');
  assert.equal(catalog.tools[0].name, 't3_environment_read');
  const result = await mcp.callMcpTool('u', 'a', 'fixture', 't3_environment_read', {});
  assert.match(JSON.stringify(result), /Fixture identity/);
  assert.ok(!JSON.stringify(result).includes('fixture-token'));
  assert.ok(!catalog.tools.some(t=>t.name==='delegate_task'));
});
test('device, argument and cross-environment restrictions are enforced before invocation', async () => {
  assert.equal(typeof mcp.callMcpTool, 'function');
  const before = requests;
  await assert.rejects(() => mcp.listMcpTools('u', 'b', 'fixture'), /denied/i);
  assert.equal(requests, before);
  await assert.rejects(() => mcp.callMcpTool('u', 'a', 'fixture', 't3_environment_read', { environmentId: 'another-device' }), /environment|arguments|device/i);
  await assert.rejects(() => mcp.callMcpTool('u', 'a', 'fixture', 'invented_tool', {}), /available|unknown/i);
});
test('rejected credentials surface a useful bounded error without leaking the token', async () => {
  assert.equal(typeof mcp.listMcpTools, 'function');
  rejectAuth = true;
  try {
    await assert.rejects(() => mcp.listMcpTools('u', 'a', 'fixture'), error => /auth|401/i.test(error.message) && !error.message.includes('fixture-token'));
  } finally { rejectAuth = false; }
});
test('owner pairing uses PKCE against the configured nightly server and never follows the supplied link', async () => {
  assert.equal(typeof pairing.pairMcpDevice, 'function');
  const before=requests;
  await assert.rejects(()=>pairing.pairMcpDevice('u','b','fixture','FIXTUREPAIR12'),/denied/i);
  assert.equal(requests,before);
  await assert.rejects(()=>pairing.pairMcpDevice('u','a','fixture','WRONGPAIR12'),/pair|400/i);
  const paired=await pairing.pairMcpDevice('u','a','fixture','http://untrusted-link.invalid/pair#token=FIXTUREPAIR12');
  assert.equal(paired.ok,true);
  assert.ok(paired.expiresAt>Date.now());
  assert.ok(!JSON.stringify(paired).includes('fixture-token'));
  assert.equal((await mcp.callMcpTool('u','a','fixture','t3_environment_read',{})).isError,false);
});
test('standalone Bot clients receive an actionable launch path instead of calling thread-bound tools', async () => {
 const before=requests;
 await assert.rejects(()=>mcp.callMcpTool('u','a','fixture','delegate_task',{}),/t3_thread_launch/);
 assert.equal(requests,before);
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
