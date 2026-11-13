'use strict';
// desktopd — local, Orgo-compatible desktop API (Xvfb + openbox + x11vnc per screen).
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8090);
const TOKEN = process.env.DESKTOP_TOKEN || '';
if (!TOKEN) { console.error('desktopd: DESKTOP_TOKEN is required'); process.exit(1); }
const RESOLUTION = process.env.RESOLUTION || '1280x800x24';
const [WIDTH, HEIGHT, DEPTH] = (() => {
  const m = /^(\d+)x(\d+)(?:x(\d+))?$/.exec(RESOLUTION);
  if (!m) { console.error(`desktopd: bad RESOLUTION ${RESOLUTION}`); process.exit(1); }
  return [Number(m[1]), Number(m[2]), Number(m[3] || 24)];
})();
const HOME = '/home/agent';
const MAX_SCREENS = 4;
const DEFAULT_DISPLAY = 99;
const VNC_BASE_PORT = 5900; // x11vnc port = 5900 + display number (default :99 -> 5999, screen-N -> 590N)
const BACKGROUND = process.env.BACKGROUND_COLOR || '#2b3a4a';
const RUN_DIR = '/tmp/desktopd';
const OUTPUT_CAP = 200_000;

const VNC_PASSWORD = (process.env.VNC_PASSWORD || (() => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), (b) => abc[b % abc.length]).join('');
})()).slice(0, 8); // VNC auth only uses the first 8 chars
const RFBAUTH = path.join(RUN_DIR, 'vncpasswd');

const baseEnv = { ...process.env, HOME, USER: 'agent', LOGNAME: 'agent', SHELL: '/bin/bash' };
delete baseEnv.DESKTOP_TOKEN;
delete baseEnv.VNC_PASSWORD;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function run(cmd, args, { env = baseEnv, timeout = 30_000, encoding = 'utf8', maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout, encoding, maxBuffer, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(stdout);
    });
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

// ---------------------------------------------------------------- screens
class Screen {
  constructor(id, display) {
    this.id = id;
    this.display = display;
    this.vncPort = VNC_BASE_PORT + display;
    this.env = { ...baseEnv, DISPLAY: `:${display}` };
    this.procs = {};
    this.stopped = false;
    this.booting = null;
    this.failures = 0;
  }

  toJSON() {
    return { id: this.id, display: `:${this.display}`, width: WIDTH, height: HEIGHT, default: this.id === 'default' };
  }

  alive(name) { return !!this.procs[name]; }

  spawnChild(name, cmd, args) {
    const p = spawn(cmd, args, { env: this.env, stdio: ['ignore', 'ignore', 'inherit'] });
    const started = Date.now();
    this.procs[name] = p;
    p.on('error', (e) => log(`[${this.id}] ${name} spawn error: ${e.message}`));
    p.on('exit', (code, sig) => {
      if (this.procs[name] !== p) return;
      delete this.procs[name];
      if (this.stopped) return;
      log(`[${this.id}] ${name} exited (code=${code} sig=${sig}); restarting`);
      this.failures = Date.now() - started > 30_000 ? 0 : this.failures + 1;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6));
      setTimeout(() => { if (!this.stopped) this.ensure().catch((e) => log(`[${this.id}] restart failed: ${e.message}`)); }, delay);
    });
    return p;
  }

  killChild(name, sig = 'SIGTERM') {
    const p = this.procs[name];
    delete this.procs[name];
    if (p && p.exitCode === null) { try { p.kill(sig); } catch {} setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 2000).unref(); }
  }

  cleanupX() {
    for (const f of [`/tmp/.X${this.display}-lock`, `/tmp/.X11-unix/X${this.display}`]) { try { fs.unlinkSync(f); } catch {} }
  }

  ensure() {
    if (this.stopped) return Promise.reject(new Error('screen stopped'));
    if (this.booting) return this.booting;
    if (this.alive('xvfb') && this.alive('wm') && this.alive('vnc')) return Promise.resolve();
    this.booting = this.boot().finally(() => { this.booting = null; });
    return this.booting;
  }

  async boot() {
    if (!this.alive('xvfb')) {
      this.killChild('wm');
      this.killChild('vnc');
      this.cleanupX();
      const x = this.spawnChild('xvfb', 'Xvfb', [`:${this.display}`, '-screen', '0', `${WIDTH}x${HEIGHT}x${DEPTH}`,
        '-ac', '-nolisten', 'tcp', '-dpi', '96', '+extension', 'RANDR']);
      await this.waitForX(x);
      run('xsetroot', ['-solid', BACKGROUND], { env: this.env }).catch(() => {});
    }
    if (!this.alive('wm')) this.spawnChild('wm', 'openbox', ['--sm-disable']);
    if (!this.alive('vnc')) {
      const v = this.spawnChild('vnc', 'x11vnc', ['-display', `:${this.display}`, '-rfbport', String(this.vncPort),
        '-localhost', '-listen', '127.0.0.1', '-rfbauth', RFBAUTH, '-forever', '-shared', '-noxdamage', '-quiet',
        '-nopw', '-noipv6', '-xkb']);
      await this.waitForPort(v);
    }
  }

  async waitForX(proc) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`Xvfb :${this.display} exited during startup`);
      if (fs.existsSync(`/tmp/.X11-unix/X${this.display}`)) {
        try { await run('xdotool', ['getdisplaygeometry'], { env: this.env, timeout: 3000 }); return; } catch {}
      }
      await sleep(100);
    }
    throw new Error(`Xvfb :${this.display} did not become ready`);
  }

  async waitForPort(proc) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`x11vnc for :${this.display} exited during startup`);
      const ok = await new Promise((r) => {
        const s = net.connect(this.vncPort, '127.0.0.1');
        s.once('connect', () => { s.destroy(); r(true); });
        s.once('error', () => r(false));
      });
      if (ok) return;
      await sleep(100);
    }
    throw new Error(`x11vnc for :${this.display} did not start listening`);
  }

  stop() {
    this.stopped = true;
    for (const n of ['vnc', 'wm', 'xvfb']) this.killChild(n);
    setTimeout(() => this.cleanupX(), 2500).unref();
  }
}

const screens = new Map(); // id -> Screen
screens.set('default', new Screen('default', DEFAULT_DISPLAY));

async function createScreen() {
  if (screens.size >= MAX_SCREENS) { const e = new Error(`maximum of ${MAX_SCREENS} screens reached`); e.status = 409; throw e; }
  let n = 1;
  while (screens.has(`screen-${n}`)) n++;
  const s = new Screen(`screen-${n}`, n);
  screens.set(s.id, s);
  try { await s.ensure(); } catch (e) { s.stop(); screens.delete(s.id); throw e; }
  return s;
}

function screenFromQuery(url) {
  const id = url.searchParams.get('screen');
  const s = screens.get(!id || id === 'default' ? 'default' : id);
  if (!s) { const e = new Error(`unknown screen: ${id}`); e.status = 404; throw e; }
  return s;
}

// ---------------------------------------------------------------- input helpers
const KEY_ALIASES = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', tab: 'Tab',
  pgdn: 'Page_Down', pagedown: 'Page_Down', page_down: 'Page_Down', pgup: 'Page_Up', pageup: 'Page_Up', page_up: 'Page_Up',
  del: 'Delete', delete: 'Delete', space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', insert: 'Insert', ins: 'Insert',
  cmd: 'super', command: 'super', super: 'super', win: 'super', windows: 'super', meta: 'super',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
};
function normalizeKey(key) {
  return String(key).split('+').map((k) => k.trim()).filter(Boolean).map((k) => {
    const lower = k.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
    return k;
  }).join('+');
}

const num = (v, name) => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) { const e = new Error(`${name} must be a number`); e.status = 400; throw e; }
  return String(Math.round(n));
};
const BUTTONS = { left: '1', middle: '2', right: '3' };

function xdo(screen, args, timeout = 30_000) { return run('xdotool', args, { env: screen.env, timeout }); }

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// ---------------------------------------------------------------- bash
function runBash(screen, command, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: HOME, env: screen.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let done = false;
    const onData = (d) => {
      if (done) return; // keep draining so inherited-fd background jobs don't get SIGPIPE
      out += d.toString('utf8');
      if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const finish = (exit_code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const output = out.length > OUTPUT_CAP ? out.slice(-OUTPUT_CAP) : out;
      resolve({ success: exit_code === 0, output, exit_code });
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      finish(124);
    }, timeoutSec * 1000);
    child.on('error', (e) => { out += `\n${e.message}`; finish(127); });
    child.on('exit', (code, sig) => {
      const exit_code = code ?? (sig ? 128 + (require('node:os').constants.signals[sig] || 0) : 1);
      let closed = 0;
      const check = () => { if (++closed >= 2) finish(exit_code); };
      if (child.stdout.readableEnded) closed++; else child.stdout.once('end', check);
      if (child.stderr.readableEnded) closed++; else child.stderr.once('end', check);
      if (closed >= 2) finish(exit_code);
      setTimeout(() => finish(exit_code), 300); // background jobs holding our pipes: don't wait for them
    });
  });
}

// ---------------------------------------------------------------- http
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.csv': 'text/csv', '.xml': 'application/xml', '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.log': 'text/plain; charset=utf-8',
};

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 << 20) { const e = new Error('body too large'); e.status = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch { const e = new Error('invalid JSON body'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return !!m && safeEqual(m[1].trim(), TOKEN);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && p === '/health') return send(res, 200, { ok: true });
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  if (m === 'GET' && p === '/computer') return send(res, 200, { id: 'local', status: 'running', name: 'local', resolution: RESOLUTION });
  if (m === 'GET' && p === '/vnc-password') return send(res, 200, { password: VNC_PASSWORD, desktop_api_token: '' });

  if (p === '/screens') {
    if (m === 'GET') return send(res, 200, { screens: [...screens.values()].map((s) => s.toJSON()) });
    if (m === 'POST') { await readJson(req).catch(() => ({})); return send(res, 200, (await createScreen()).toJSON()); }
  }
  const sm = /^\/screens\/([^/]+)$/.exec(p);
  if (sm) {
    const s = screens.get(decodeURIComponent(sm[1]));
    if (!s) return send(res, 404, { error: 'screen not found' });
    if (m === 'GET') return send(res, 200, s.toJSON());
    if (m === 'DELETE') {
      if (s.id === 'default') return send(res, 400, { error: 'cannot delete the default screen' });
      s.stop();
      screens.delete(s.id);
      return send(res, 200, { success: true });
    }
  }

  if (m === 'GET' && p === '/files') {
    const raw = url.searchParams.get('path');
    if (!raw || !path.isAbsolute(raw)) return send(res, 400, { error: 'path must be absolute' });
    let real;
    try { real = await fs.promises.realpath(raw); } catch { return send(res, 404, { error: 'not found' }); }
    if (real !== HOME && !real.startsWith(HOME + '/')) return send(res, 403, { error: 'forbidden' });
    let st;
    try { st = await fs.promises.stat(real); } catch { return send(res, 404, { error: 'not found' }); }
    if (!st.isFile()) return send(res, 400, { error: 'not a regular file' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `inline; filename="${path.basename(real).replace(/["\\\r\n]/g, '_')}"`,
    });
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    return;
  }

  // Everything below operates on a screen.
  const screen = screenFromQuery(url);

  if (m === 'GET' && p === '/screenshot') {
    await screen.ensure();
    const buf = await run('import', ['-display', screen.env.DISPLAY, '-window', 'root', '-quality', '75', 'jpeg:-'],
      { env: screen.env, encoding: 'buffer', timeout: 20_000 });
    const size = jpegSize(buf) || { width: WIDTH, height: HEIGHT };
    return send(res, 200, { image: buf.toString('base64'), mime_type: 'image/jpeg', width: size.width, height: size.height });
  }

  if (m !== 'POST') return send(res, 404, { error: 'not found' });
  const body = await readJson(req);

  switch (p) {
    case '/click': {
      const btn = BUTTONS[body.button || 'left'];
      if (!btn) return send(res, 400, { error: 'button must be left, right or middle' });
      const args = ['mousemove', num(body.x, 'x'), num(body.y, 'y'), 'click'];
      if (body.double) args.push('--repeat', '2', '--delay', '80');
      args.push(btn);
      await screen.ensure(); await xdo(screen, args);
      return send(res, 200, { success: true });
    }
    case '/mouse-move':
      await screen.ensure(); await xdo(screen, ['mousemove', num(body.x, 'x'), num(body.y, 'y')]);
      return send(res, 200, { success: true });
    case '/drag': {
      const [sx, sy, ex, ey] = [num(body.start_x, 'start_x'), num(body.start_y, 'start_y'), num(body.end_x, 'end_x'), num(body.end_y, 'end_y')].map(Number);
      await screen.ensure();
      await xdo(screen, ['mousemove', String(sx), String(sy), 'sleep', '0.05', 'mousedown', '1']);
      try {
        const steps = 12;
        const args = [];
        for (let i = 1; i <= steps; i++) {
          args.push('mousemove', String(Math.round(sx + ((ex - sx) * i) / steps)), String(Math.round(sy + ((ey - sy) * i) / steps)), 'sleep', '0.02');
        }
        await xdo(screen, args);
      } finally {
        await xdo(screen, ['mouseup', '1']);
      }
      return send(res, 200, { success: true });
    }
    case '/type': {
      if (typeof body.text !== 'string') return send(res, 400, { error: 'text must be a string' });
      await screen.ensure();
      if (body.text.length) await xdo(screen, ['type', '--delay', '12', '--', body.text], 30_000 + body.text.length * 60);
      return send(res, 200, { success: true });
    }
    case '/key': {
      const key = normalizeKey(body.key || '');
      if (!key) return send(res, 400, { error: 'key is required' });
      await screen.ensure(); await xdo(screen, ['key', '--clearmodifiers', key]);
      return send(res, 200, { success: true });
    }
    case '/scroll': {
      const dir = body.direction || 'down';
      if (dir !== 'up' && dir !== 'down') return send(res, 400, { error: "direction must be 'up' or 'down'" });
      const amount = Math.max(1, Math.min(100, Math.round(Number(body.amount) || 3)));
      await screen.ensure();
      await xdo(screen, ['mousemove', num(body.x, 'x'), num(body.y, 'y'), 'click', '--repeat', String(amount), '--delay', '30', dir === 'up' ? '4' : '5']);
      return send(res, 200, { success: true });
    }
    case '/bash': {
      if (typeof body.command !== 'string' || !body.command) return send(res, 400, { error: 'command is required' });
      const timeout = Math.max(1, Math.min(300, Number(body.timeout) || 120));
      screen.ensure().catch(() => {}); // display is a convenience for bash; don't block on it
      return send(res, 200, await runBash(screen, body.command, timeout));
    }
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) log(`${req.method} ${req.url} failed:`, e.message, e.stderr || '');
    if (!res.headersSent) send(res, status, { error: e.message + (e.stderr ? `: ${e.stderr.trim().slice(0, 500)}` : '') });
    else res.destroy();
  });
});
server.requestTimeout = 0; // bash may legitimately run for 300s
server.headersTimeout = 30_000;

// ---------------------------------------------------------------- websockify
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const reject = (code, msg) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  if (url.pathname.replace(/\/+$/, '') !== '/websockify') return reject(404, 'Not Found');
  if (!safeEqual(url.searchParams.get('token') || '', VNC_PASSWORD)) return reject(401, 'Unauthorized');
  const id = url.searchParams.get('screen');
  const screen = screens.get(!id || id === 'default' ? 'default' : id);
  if (!screen) return reject(404, 'Not Found');
  screen.ensure().then(() => {
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, screen));
  }, (e) => { log(`websockify: ${e.message}`); reject(503, 'Service Unavailable'); });
});

function bridge(ws, screen) {
  const tcp = net.connect(screen.vncPort, '127.0.0.1');
  tcp.setNoDelay(true);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
  };
  tcp.on('data', (d) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(d, { binary: true });
    if (ws.bufferedAmount > 8 << 20) {
      tcp.pause();
      const iv = setInterval(() => { if (closed || ws.bufferedAmount < 1 << 20) { clearInterval(iv); tcp.resume(); } }, 20);
    }
  });
  ws.on('message', (d) => { if (!closed) tcp.write(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
  tcp.on('end', close);
  tcp.on('close', close);
  tcp.on('error', (e) => { log(`[${screen.id}] vnc tcp error: ${e.message}`); close(); });
  ws.on('close', close);
  ws.on('error', close);
}

// ---------------------------------------------------------------- startup
async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  await run('x11vnc', ['-storepasswd', VNC_PASSWORD, RFBAUTH]);
  fs.chmodSync(RFBAUTH, 0o600);
  server.listen(PORT, '0.0.0.0', () => log(`desktopd listening on :${PORT} (resolution ${RESOLUTION})`));
  try { await screens.get('default').ensure(); log('default screen :99 ready'); }
  catch (e) { log(`default screen failed to start: ${e.message} (will retry on demand)`); }
}

function shutdown() {
  log('shutting down');
  for (const s of screens.values()) s.stop();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((e) => { console.error(e); process.exit(1); });
