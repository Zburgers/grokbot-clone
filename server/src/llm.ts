import OpenAI from 'openai';
import { env } from './env.js';

/**
 * The model endpoint. Any OpenAI Responses-API server works; by default this is the local
 * CLIProxyAPI (Codex / Antigravity subscriptions) serving gpt-6-luna.
 */
export function llmClient(timeout: number) {
  return new OpenAI({ apiKey: env.llmKey, baseURL: env.llmBaseUrl, timeout });
}

/** True when talking to xAI directly (enables xAI-only endpoints such as /responses/compact). */
export const isXai = env.llmBaseUrl.includes('api.x.ai');

/** Hosted (non-function) tools for the agent loop. */
export const builtinTools = () => env.llmBuiltinTools.map((type) => ({ type }));

/** Statuses worth retrying on the fallback model (rate limit, quota, upstream outage). */
export const shouldFallback = (e: any) => !!env.llmFallbackModel && [429, 500, 502, 503, 504].includes(Number(e?.status));

/** Per-Bot override, or the configured server default. */
export const modelFor = (bot: { model?: string }) => bot.model || env.llmModel;

/** Fetch identifiers from the configured endpoint; credentials stay on the server. */
export async function availableModels(): Promise<string[]> {
  const page = await llmClient(15_000).models.list();
  return [...new Set(page.data.map((m) => m.id).filter((id) => typeof id === 'string' && !!id))].sort();
}
