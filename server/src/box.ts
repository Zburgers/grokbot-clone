import { env } from './env.js';
import { orgo, OrgoError, type OrgoComputer, type OrgoScreen } from './orgo.js';

/**
 * The agent's computer. `local` talks to the grokbot-desktop container (desktop/), whose daemon
 * mirrors Orgo's desktop API; there is one shared box, so the computer id is always "local".
 */

async function call<T = any>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${env.desktopUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.desktopToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
    if (!res.ok) throw new OrgoError(res.status, undefined, `Desktop ${method} ${path}: ${json?.error ?? res.status}`, json);
    return json as T;
  } catch (e: any) {
    if (e instanceof OrgoError) throw e;
    // Container down / unreachable: a 503, never a 404 (404 makes computer.ts forget the box).
    throw new OrgoError(503, 'unreachable', `Local desktop unreachable at ${env.desktopUrl} (is the grokbot-desktop container running?): ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

const q = (screen?: string) => (screen && screen !== 'default' ? `?screen=${encodeURIComponent(screen)}` : '');
const running = (): OrgoComputer => ({ id: 'local', status: 'running', name: 'local' });

const local: typeof orgo & { vncUrl: (id: string, screen: string, password: string) => string; readFile: (path: string) => Promise<Response> } = {
  workspaces: async () => [{ id: 'local' }],
  createComputer: async () => { await call('GET', '/computer'); return running(); },
  getComputer: async () => { await call('GET', '/computer', undefined, { timeoutMs: 10_000 }); return running(); },
  start: async () => ({}),
  resume: async () => ({}),
  suspend: async () => ({}),
  vncPassword: () => call('GET', '/vnc-password'),

  listScreens: () => call<{ screens: OrgoScreen[] }>('GET', '/screens').then((r) => r.screens ?? []),
  createScreen: () => call<OrgoScreen>('POST', '/screens', {}),
  getScreen: (_id, screen) => call<OrgoScreen>('GET', `/screens/${encodeURIComponent(screen)}`),
  deleteScreen: (_id, screen) => call<void>('DELETE', `/screens/${encodeURIComponent(screen)}`),

  screenshot: (_id, screen) => call('GET', `/screenshot${q(screen)}`, undefined, { timeoutMs: 30_000 }),
  click: (_id, screen, b) => call('POST', `/click${q(screen)}`, b),
  move: (_id, screen, b) => call('POST', `/mouse-move${q(screen)}`, b),
  drag: (_id, screen, b) => call('POST', `/drag${q(screen)}`, b),
  type: (_id, screen, text) => call('POST', `/type${q(screen)}`, { text }, { timeoutMs: 30_000 + text.length * 80 }),
  key: (_id, screen, key) => call('POST', `/key${q(screen)}`, { key }),
  scroll: (_id, screen, b) => call('POST', `/scroll${q(screen)}`, b),
  bash: (_id, screen, command, timeout = 120) => call('POST', `/bash${q(screen)}`, { command, timeout }, { timeoutMs: (timeout + 40) * 1000 }),
  /** Not used locally: files are streamed by readFile through our own authenticated route. */
  exportFile: async () => { throw new Error('exportFile is not supported by the local desktop'); },

  vncUrl: (_id, screen, password) =>
    `${env.desktopUrl.replace(/^http/, 'ws')}/websockify?token=${encodeURIComponent(password)}${screen !== 'default' ? `&screen=${encodeURIComponent(screen)}` : ''}`,
  readFile: (path) => fetch(`${env.desktopUrl}/files?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${env.desktopToken}` } }),
};

const cloud = {
  ...orgo,
  vncUrl: (id: string, screen: string, password: string) =>
    `wss://www.orgo.ai/desktops/${id}/ws/websockify?token=${encodeURIComponent(password)}${screen !== 'default' ? `&screen=${encodeURIComponent(screen)}` : ''}`,
  readFile: async (_path: string): Promise<Response> => { throw new Error('readFile is only available for the local desktop'); },
};

export const isLocalBox = env.computerProvider === 'local';
export const box = isLocalBox ? local : cloud;
export { OrgoError };
