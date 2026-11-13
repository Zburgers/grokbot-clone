function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}
const opt = (name: string) => process.env[name] || '';

/** 'local' = the grokbot-desktop Docker container on this machine; 'orgo' = Orgo cloud computers. */
const computerProvider = (process.env.COMPUTER_PROVIDER ?? 'local') === 'orgo' ? 'orgo' : 'local';

export const env = {
  port: Number(process.env.PORT ?? 8787),
  /** Bind address. Keep 127.0.0.1 and publish through Tailscale Serve. */
  host: process.env.HOST ?? '127.0.0.1',
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,

  // ---- model (any OpenAI Responses-API endpoint: CLIProxyAPI, OpenAI, xAI) ----
  llmBaseUrl: process.env.LLM_BASE_URL ?? (process.env.XAI_API_KEY && !process.env.LLM_API_KEY ? 'https://api.x.ai/v1' : 'http://127.0.0.1:8317/v1'),
  llmKey: process.env.LLM_API_KEY || process.env.XAI_API_KEY || '',
  llmModel: process.env.LLM_MODEL ?? process.env.XAI_MODEL ?? 'gpt-6-luna',
  /** Optional cheaper/backup model for background work (memory, summaries) and as a fallback when the main one fails. */
  llmFallbackModel: opt('LLM_FALLBACK_MODEL'),
  /** Hosted tools passed to the model, comma-separated (xAI: web_search,x_search; OpenAI/Codex: web_search). */
  llmBuiltinTools: (process.env.LLM_BUILTIN_TOOLS ?? 'web_search').split(',').map((s) => s.trim()).filter(Boolean),

  // ---- xAI (voice only) ----
  xaiKey: opt('XAI_API_KEY'),
  voiceEnabled: process.env.VOICE_ENABLED === '1' && !!process.env.XAI_API_KEY,

  composioKey: req('COMPOSIO_API_KEY'),
  /** Show "Continue with Google" (sign-in through a Composio Gmail connection). */
  googleLogin: process.env.GOOGLE_LOGIN === '1',

  // ---- computer ----
  computerProvider: computerProvider as 'local' | 'orgo',
  /** grokbot-desktop daemon (local provider). */
  desktopUrl: process.env.DESKTOP_URL ?? 'http://127.0.0.1:18090',
  desktopToken: computerProvider === 'local' ? req('DESKTOP_TOKEN') : opt('DESKTOP_TOKEN'),
  /** Where bot profiles and files live on the computer. */
  boxHome: process.env.BOX_HOME ?? (computerProvider === 'local' ? '/home/agent/grokbot' : '/root/grokbot'),
  orgoKey: computerProvider === 'orgo' ? req('ORGO_API_KEY') : opt('ORGO_API_KEY'),
  /** Orgo workspace that holds every user's box. */
  orgoWorkspaceId: process.env.ORGO_WORKSPACE_ID ?? '',
  /** Orgo box size for new users. */
  orgoRamGb: Number(process.env.ORGO_RAM_GB ?? 8),
  orgoCpu: Number(process.env.ORGO_CPU ?? 2),
  orgoResolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',

  sessionSecret: req('SESSION_SECRET'),
  /** Single-owner password login: OWNER_PASSWORD_HASH is "scrypt$<salt hex>$<hash hex>" (see scripts/hash-password.mjs). */
  ownerEmail: process.env.OWNER_EMAIL ?? 'owner@localhost',
  ownerName: process.env.OWNER_NAME ?? 'Owner',
  ownerPasswordHash: opt('OWNER_PASSWORD_HASH'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,
};

if (!env.llmKey) throw new Error('Missing env LLM_API_KEY');
