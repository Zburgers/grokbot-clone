import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { db } from './db.js';
import { env } from './env.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage<{ userId: string; botIds: string[] }>();
export const currentKnowledgeScope = () => [...(scopes.getStore()?.botIds ?? [])];
export function withKnowledgeScope<T>(userId: string, botIds: string[], job: () => T): T {
  const parent = scopes.getStore();
  if (parent && parent.userId !== userId) throw new Error('Knowledge access denied.');
  const ids = [...new Set([...(parent?.botIds ?? []), ...botIds])];
  if (ids.length > 64) throw new Error('Knowledge access denied: forwarding chain is too long.');
  return scopes.run({ userId, botIds: ids }, job);
}

const ids = z.array(z.string().min(1).max(100)).max(100);
const sourceSchema = z.object({ id: z.string(), label: z.string(), root: z.string(), files: z.array(z.string()).max(100) });
const deviceSchema = z.object({ id: z.string(), label: z.string(), url: z.url(), token: z.string().optional(), expiresAt: z.number().optional() });
const configSchema = z.object({ sources: z.array(sourceSchema).max(50), devices: z.array(deviceSchema).max(50), grants: z.record(z.string(), z.object({ sources: ids, devices: ids })) });
export type KnowledgeSource = z.infer<typeof sourceSchema>;
export type McpDevice = z.infer<typeof deviceSchema>;
export const knowledgeConfigPath = () => process.env.GROKBOT_KNOWLEDGE_CONFIG || join(dirname(env.dbPath), 'knowledge.json');

/** This file is owner-managed. Model tool calls cannot add sources, credentials or grants. */
export function knowledgeConfig() {
  try { return configSchema.parse(JSON.parse(readFileSync(knowledgeConfigPath(), 'utf8'))); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { sources: [], devices: [], grants: {} } as z.infer<typeof configSchema>;
    throw new Error('Knowledge configuration is invalid or unreadable. Ask the owner to check it.');
  }
}

function ownAccess(userId: string, botId: string): { sources: string[]; devices: string[] } {
  const seen = new Set<string>();
  while (true) {
    if (seen.has(botId)) throw new Error('Knowledge access denied.');
    seen.add(botId);
    const bot = db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
    if (!bot || bot.user_id !== userId) throw new Error('Knowledge access denied.');
    // A helper can never override its parent's policy with a grant of its own.
    if (bot.parent_bot_id) {
      if (!bot.hidden) throw new Error('Knowledge access denied.');
      botId = bot.parent_bot_id;
      continue;
    }
    const grant = knowledgeConfig().grants[botId];
    return grant ? { sources: [...grant.sources], devices: [...grant.devices] } : { sources: [], devices: [] };
  }
}

export function knowledgeAccess(userId: string, botId: string): { sources: string[]; devices: string[] } {
  const scope = scopes.getStore();
  if (scope && scope.userId !== userId) throw new Error('Knowledge access denied.');
  let access = ownAccess(userId, botId);
  for (const origin of scope?.botIds ?? []) {
    const inherited = ownAccess(userId, origin);
    access = { sources: access.sources.filter(id => inherited.sources.includes(id)), devices: access.devices.filter(id => inherited.devices.includes(id)) };
  }
  return access;
}

export function allowedSources(userId: string, botId: string) {
  const grant = knowledgeAccess(userId, botId);
  return knowledgeConfig().sources.filter(s => grant.sources.includes(s.id));
}

export function allowedDevice(userId: string, botId: string, deviceId: string): McpDevice {
  const grant = knowledgeAccess(userId, botId);
  const device = knowledgeConfig().devices.find(d => d.id === deviceId && grant.devices.includes(d.id));
  if (!device) throw new Error('Device access denied.');
  const url = new URL(device.url);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Device requires HTTPS or host-local HTTP without URL credentials.');
  }
  return device;
}

/** Credentials are write-only to the owner UI and kept out of the model's tool interface. */
export function setDeviceToken(userId: string, botId: string, deviceId: string, token: string, expiresAt?: number) {
  allowedDevice(userId, botId, deviceId);
  if (typeof token !== 'string' || token.length < 8 || token.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Error('Invalid T3 access token.');
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error('Token expiry must be in the future.');
  const config = knowledgeConfig();
  const device = config.devices.find(d => d.id === deviceId)!;
  device.token = token;
  device.expiresAt = expiresAt;
  const file = knowledgeConfigPath(), temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { try { unlinkSync(temp); } catch { /* renamed or not created */ } }
}
