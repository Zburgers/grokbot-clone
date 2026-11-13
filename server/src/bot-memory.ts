import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';

export const ACTIVE_MEMORY = "status='active' AND (expires_at IS NULL OR expires_at>?)";
export function activeMemories(botId: string, limit = 500): any[] {
  return db.prepare(`SELECT * FROM memories WHERE bot_id=? AND ${ACTIVE_MEMORY} ORDER BY created_at DESC LIMIT ?`).all(botId, now(), limit);
}
function clean(text: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Memory text must contain 1–4000 characters.');
  return text.trim();
}
export function saveMemory(botId: string, text: string, options: { kind?: 'durable' | 'observation'; expiresAt?: number; source?: 'chat' | 'learned' } = {}) {
  const value = clean(text);
  const existing = activeMemories(botId).find(m => m.text.toLowerCase() === value.toLowerCase());
  if (existing) return existing;
  const id = newId('mem');
  const kind = options.kind === 'observation' ? 'observation' : 'durable';
  const expires = kind === 'observation' ? options.expiresAt ?? now() + 7 * 86400_000 : null;
  if (expires !== null && !Number.isFinite(expires)) throw new Error('Invalid memory expiry.');
  db.prepare('INSERT INTO memories(id,bot_id,text,created_at,source,kind,expires_at) VALUES (?,?,?,?,?,?,?)').run(id, botId, value, now(), options.source ?? 'chat', kind, expires);
  return db.prepare('SELECT * FROM memories WHERE id=?').get(id) as any;
}
function audit(memory: any, action: string, reason: string) {
  db.prepare('INSERT INTO memory_events(id,memory_id,bot_id,action,text,reason,created_at) VALUES (?,?,?,?,?,?,?)').run(newId('mev'), memory.id, memory.bot_id, action, memory.text, reason.slice(0, 1000), now());
}
export function correctMemory(botId: string, id: string, text: string, reason: string) {
  clean(text);
  return db.transaction(() => {
    const old = db.prepare("SELECT * FROM memories WHERE id=? AND bot_id=? AND status='active'").get(id, botId) as any;
    if (!old) throw new Error('Active memory not found for this Bot.');
    if (old.text.trim() === text.trim()) return old;
    const next = saveMemory(botId, text, { kind: old.kind, source: old.source });
    db.prepare("UPDATE memories SET status='superseded',superseded_by=? WHERE id=? AND bot_id=?").run(next.id, id, botId);
    audit(old, 'corrected', reason || 'Corrected in conversation');
    return next;
  })();
}
export function forgetMemory(botId: string, id: string, reason: string) {
  return db.transaction(() => {
    const old = db.prepare("SELECT * FROM memories WHERE id=? AND bot_id=? AND status='active'").get(id, botId) as any;
    if (!old) return false;
    db.prepare("UPDATE memories SET status='forgotten' WHERE id=? AND bot_id=?").run(id, botId);
    audit(old, 'forgotten', reason || 'Forgotten in conversation');
    return true;
  })();
}
export function recallMemory(botId: string, query: string) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
  const matches = activeMemories(botId).filter(m => !terms.length || terms.some(t => m.text.toLowerCase().includes(t)));
  const hits: any[] = [];
  let size = 0;
  for (const memory of matches) {
    const length = JSON.stringify(memory).length;
    if (hits.length >= 20 || size + length > 18_000) continue;
    hits.push(memory); size += length;
  }
  return hits;
}
