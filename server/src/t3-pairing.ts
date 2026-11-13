import { createHash, randomBytes } from 'node:crypto';
import { allowedDevice, setDeviceToken } from './knowledge-policy.js';

/** Owner-only, explicit pairing. Bots never collect codes or start an OAuth flow. */
export async function pairMcpDevice(userId: string, botId: string, deviceId: string, input: string) {
  const device = allowedDevice(userId, botId, deviceId);
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Invalid T3 pairing link or code.');
  let code = input.trim();
  if (/^https?:\/\//i.test(code)) {
    try { code = new URLSearchParams(new URL(code).hash.slice(1)).get('token') ?? ''; }
    catch { throw new Error('Invalid T3 pairing link.'); }
  }
  if (!/^[A-Za-z0-9._~-]{6,256}$/.test(code)) throw new Error('Invalid T3 pairing code.');
  // Never navigate or send credentials to an address supplied in the pairing link.
  const origin = new URL(device.url).origin;
  const redirect = 'http://127.0.0.1:8787/t3-mcp-callback';
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const post = async (path: string, body: Record<string, string> | Record<string, unknown>, form = false): Promise<any> => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`T3 pairing failed (HTTP ${response.status}). Create a fresh pairing code in the running T3 app and try again.`);
    const text = await response.text();
    if (text.length > 32_000) throw new Error('T3 pairing response exceeded its size limit.');
    try { return JSON.parse(text); } catch { throw new Error('T3 pairing returned an invalid response.'); }
  };
  const client = await post('/oauth/mcp/register', { client_name: 'Grokbot', redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
  if (typeof client.client_id !== 'string' || client.client_id.length > 16_000) throw new Error('T3 client registration failed.');
  const authorization = { response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, resource: device.url };
  const decision = await post('/oauth/mcp/decision', { authorization, decision: { _tag: 'pairing-code', access: 'approval-required', code } });
  let callback: URL;
  try { callback = new URL(decision.redirectTo); } catch { throw new Error('T3 pairing callback is invalid.'); }
  if (callback.origin !== new URL(redirect).origin || callback.pathname !== new URL(redirect).pathname || callback.searchParams.get('state') !== state || !callback.searchParams.get('code')) throw new Error('T3 pairing callback could not be verified.');
  const session = await post('/oauth/mcp/token', { grant_type: 'authorization_code', code: callback.searchParams.get('code')!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: device.url }, true);
  if (session.token_type !== 'Bearer' || typeof session.access_token !== 'string' || !Number.isFinite(session.expires_in) || session.expires_in <= 0 || session.expires_in > 90 * 86400) throw new Error('T3 returned an invalid MCP session.');
  const expiresAt = Date.now() + session.expires_in * 1000;
  setDeviceToken(userId, botId, deviceId, session.access_token, expiresAt);
  return { ok: true, expiresAt };
}
