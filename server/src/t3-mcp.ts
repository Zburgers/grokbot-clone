import { Client, StreamableHTTPClientTransport, type JsonSchemaType } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { allowedDevice, knowledgeAccess, knowledgeConfig } from './knowledge-policy.js';

const validator = new AjvJsonSchemaValidator();
const statuses = new Map<string, { checkedAt: number; connected: boolean; detail: string }>();
// Fixed application policy: a server's self-declared annotations cannot authorize writes.
export const MCP_READ_TOOLS = new Set(['t3_environment_read', 't3_project_list', 't3_project_read', 't3_thread_list', 't3_thread_read', 't3_thread_search', 'orchestrator_capabilities', 'task_status']);
const BLOCKED_TOOLS = new Set(['request_secret', 't3_environment_link', 't3_environment_unlink', 't3_environment_links']);
class SafeMcpError extends Error {}

export function mcpDevices(userId: string, botId: string) {
  const grant = knowledgeAccess(userId, botId);
  return knowledgeConfig().devices.filter(d => grant.devices.includes(d.id)).map(d => ({ id: d.id, label: d.label, url: d.url, configured: !!d.token, expiresAt: d.expiresAt ?? null, ...(statuses.get(d.id) ?? { checkedAt: null, connected: false, detail: d.token ? 'Not tested yet' : 'T3 access token required' }) }));
}

async function withClient<T>(userId: string, botId: string, deviceId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const device = allowedDevice(userId, botId, deviceId);
  if (!device.token) throw new SafeMcpError('T3 authentication required. Add a separately issued scoped access token in Bot settings.');
  if (device.expiresAt && device.expiresAt <= Date.now()) throw new SafeMcpError('T3 access token has expired. Ask the owner to replace it.');
  const deadline = AbortSignal.timeout(45_000);
  let transportFailure = '';
  const client = new Client({ name: 'grokbot', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, listMaxPages: 10 });
  client.onerror = () => {}; // Raw transport errors may contain remote payloads; report a safe diagnostic below.
  const transport = new StreamableHTTPClientTransport(new URL(device.url), {
    authProvider: { token: async () => device.token },
    requestInit: { redirect: 'error' },
    fetch: async (input, init) => {
      const signal = init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
      const response = await fetch(input, { ...init, signal, redirect: 'error' });
      if (response.status === 401 || response.status === 403) {
        transportFailure = `T3 authentication rejected (HTTP ${response.status}). Issue or renew a scoped token on this device.`;
        throw new SafeMcpError(transportFailure);
      }
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 2_000_000) throw new SafeMcpError('T3 response exceeded the transport size limit. Narrow the request.');
        controller.enqueue(chunk);
      } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  try {
    await client.connect(transport);
    const result = await fn(client);
    statuses.set(device.id, { checkedAt: Date.now(), connected: true, detail: 'Authenticated MCP connection succeeded' });
    return result;
  } catch (error) {
    const detail = transportFailure || (error instanceof SafeMcpError ? error.message : 'T3 MCP request failed. Check device reachability, token permissions, and server compatibility.');
    statuses.set(device.id, { checkedAt: Date.now(), connected: false, detail });
    throw new SafeMcpError(detail);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(userId: string, botId: string, deviceId: string, query = '') {
  return withClient(userId, botId, deviceId, async client => {
    const { tools } = await client.listTools();
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const available = tools.filter(t => !BLOCKED_TOOLS.has(t.name));
    const matches = available.filter(t => terms.every(term => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(term)));
    const picked: typeof tools = [];
    let size = 0;
    for (const tool of matches) {
      const length = Buffer.byteLength(JSON.stringify(tool));
      if (picked.length >= 30 || size + length > 18_000) continue;
      picked.push(tool); size += length;
    }
    const catalog = { device: deviceId, total: available.length, tools: picked, omitted: matches.length - picked.length, hint: 'Use an exact tool name as query to retrieve its schema when the catalog is large.' };
    const token = allowedDevice(userId, botId, deviceId).token;
    return token ? JSON.parse(JSON.stringify(catalog).replaceAll(token, '[redacted]')) as typeof catalog : catalog;
  });
}

function checkArguments(args: unknown, depth = 0) {
  if (depth > 20) throw new SafeMcpError('T3 arguments are too deeply nested.');
  if (!args || typeof args !== 'object') return;
  for (const [key, value] of Object.entries(args)) {
    if (key === 'environmentId' && value) throw new SafeMcpError('Cross-environment arguments are denied. Select an approved device instead.');
    checkArguments(value, depth + 1);
  }
}

export async function callMcpTool(userId: string, botId: string, deviceId: string, name: string, args: Record<string, unknown>) {
  // Resolve the grant before tool discovery or any outbound request, including after approval resumes.
  allowedDevice(userId, botId, deviceId);
  checkArguments(args);
  if (BLOCKED_TOOLS.has(name)) throw new SafeMcpError('This T3 tool requires owner-side setup and is unavailable to Bots.');
  if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 60_000) throw new SafeMcpError('Invalid or oversized T3 tool arguments.');
  return withClient(userId, botId, deviceId, async client => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new SafeMcpError('Unknown T3 tool; discover available tools first.');
    let valid = false;
    try { valid = validator.getValidator(tool.inputSchema as JsonSchemaType)(args).valid; } catch { /* invalid remote schema */ }
    if (!valid) throw new SafeMcpError('T3 arguments do not match the advertised tool schema.');
    const result = await client.callTool({ name, arguments: args }, { timeout: 35_000 });
    // Token values are never returned, even if a misconfigured server echoes request headers.
    const token = allowedDevice(userId, botId, deviceId).token;
    let text = JSON.stringify(result);
    if (token) text = text.replaceAll(token, '[redacted]');
    return { device: deviceId, tool: name, isError: !!result.isError, result: text.slice(0, 20_000), truncated: text.length > 20_000 };
  });
}
