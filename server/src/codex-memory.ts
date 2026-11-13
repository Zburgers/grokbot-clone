import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { allowedSources, type KnowledgeSource } from './knowledge-policy.js';

const MAX_FILE = 256_000;
const safePath = (path: string) => !isAbsolute(path) && !path.includes('\\') && path.split('/').every(p => p && p !== '..' && !p.startsWith('.')) && path.endsWith('.md');
const matches = (path: string, pattern: string) => {
  if (path === pattern) return true;
  const dir = pattern.slice(0, -5);
  return pattern.endsWith('/*.md') && path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/');
};

async function files(source: KnowledgeSource): Promise<string[]> {
  const paths: string[] = [];
  for (const pattern of source.files) {
    if (pattern.endsWith('/*.md')) {
      const dir = pattern.slice(0, -5);
      if (!safePath(`${dir}/placeholder.md`)) continue;
      try {
        const entries = await readdir(resolve(source.root, dir), { withFileTypes: true });
        paths.push(...entries.filter(e => e.isFile() && e.name.endsWith('.md')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 100).map(e => `${dir}/${e.name}`));
      } catch { /* a configured source may not exist on this host yet */ }
    } else if (safePath(pattern)) paths.push(pattern);
  }
  return [...new Set(paths)].slice(0, 100);
}

async function read(source: KnowledgeSource, path: string) {
  if (!safePath(path) || !source.files.some(p => matches(path, p))) throw new Error('Memory file access denied.');
  let handle;
  try {
    const root = await realpath(source.root);
    const file = resolve(root, path);
    const canonical = await realpath(file);
    const rel = relative(root, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('denied');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('unavailable');
    const buffer = Buffer.alloc(MAX_FILE + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE) throw new Error('unavailable');
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), modifiedAt: stat.mtime.toISOString() };
  } catch { throw new Error('Memory file unavailable or access denied.'); }
  finally { await handle?.close(); }
}

/** Read a bounded excerpt, never the whole archive. Source paths are relative and cited. */
export async function readCodexMemory(userId: string, botId: string, sourceId: string, path: string, startLine = 1, lineCount = 60) {
  const source = allowedSources(userId, botId).find(s => s.id === sourceId);
  if (!source) throw new Error('Memory source access denied.');
  const data = await read(source, path);
  const start = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1;
  const count = Number.isFinite(lineCount) ? Math.min(100, Math.max(1, Math.floor(lineCount))) : 60;
  const lines = data.text.split('\n');
  const text = lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 12_000);
  return { source: source.id, path, modifiedAt: data.modifiedAt, startLine: start, totalLines: lines.length, text, historical: true };
}

export async function searchCodexMemory(userId: string, botId: string, query: string) {
  const terms = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 20);
  if (!terms.length) return [];
  const hits: { source: string; path: string; modifiedAt: string; startLine: number; text: string; score: number; historical: boolean }[] = [];
  let scanned = 0;
  for (const source of allowedSources(userId, botId)) {
    for (const path of await files(source)) {
      if (++scanned > 100) break;
      try {
        const data = await read(source, path);
        const lines = data.text.split('\n');
        let best = -1, score = 0;
        lines.forEach((line, index) => {
          const n = terms.filter(t => line.toLowerCase().includes(t)).length;
          if (n > score) { score = n; best = index; }
        });
        if (!score) continue;
        const start = Math.max(0, best - 3);
        hits.push({ source: source.id, path, modifiedAt: data.modifiedAt, startLine: start + 1, text: lines.slice(start, start + 30).map((line, i) => `${start + i + 1}: ${line}`).join('\n').slice(0, 3000), score, historical: true });
      } catch { /* missing or unsafe files do not make other knowledge unavailable */ }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 5);
}
