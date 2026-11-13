import { useState } from 'react';
import { configApi, type BotSettingsBundle } from '../../lib/configApi';

export function KnowledgeConnections({ botId, knowledge, onChange }: { botId: string; knowledge: BotSettingsBundle['knowledge']; onChange: () => void }) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const run = async (id: string, save: boolean) => {
    setBusy(id); setMessage('');
    try {
      if (save) {
        await configApi.setMcpToken(botId, id, tokens[id]);
        setTokens(t => ({ ...t, [id]: '' }));
      }
      const result = await configApi.testMcp(botId, id);
      setMessage(`Connected. Discovered ${result.toolCount} tools and verified server identity.`);
    } catch (e: any) { setMessage(e.message || 'Connection failed.'); }
    finally { setBusy(null); onChange(); }
  };
  return <section className="cfg-section" aria-label="Knowledge and T3 connections">
    <div className="cfg-section__title">Codex knowledge</div>
    <p className="cfg-field__hint">Read-only access to approved historical notes. Bots search relevant sources when needed.</p>
    {knowledge.sources.length ? knowledge.sources.map(s => <div key={s.id} className="cfg-item">{s.label}</div>) : <p className="cfg-field__hint">No Codex sources assigned to this Bot.</p>}
    <div className="cfg-section__title">T3 devices</div>
    <p className="cfg-field__hint">Only devices assigned to this Bot appear here. Add a scoped T3 access token from the device's owner controls. Tokens are stored privately and never sent to the model.</p>
    {!knowledge.devices.length && <p className="cfg-field__hint">No T3 devices assigned to this Bot.</p>}
    {knowledge.devices.map(d => <div key={d.id} className="cfg-field">
      <label htmlFor={`mcp-token-${d.id}`}>{d.label}</label>
      <div className="cfg-field__hint">{d.url}</div>
      <div className="cfg-field__hint">{d.detail}{d.expiresAt ? ` · Expires ${new Date(d.expiresAt).toLocaleDateString()}` : ''}</div>
      <input id={`mcp-token-${d.id}`} className="text-input" type="password" autoComplete="off" placeholder={d.configured ? 'Replace access token' : 'T3 access token'} value={tokens[d.id] ?? ''} onChange={e => setTokens(t => ({ ...t, [d.id]: e.target.value }))} />
      <div className="cfg-item__actions">
        <button className="btn" type="button" disabled={!!busy || !tokens[d.id]} onClick={() => run(d.id, true)}>Save and connect</button>
        <button className="btn" type="button" disabled={!!busy || !d.configured} onClick={() => run(d.id, false)}>{busy === d.id ? 'Connecting…' : 'Test connection'}</button>
      </div>
    </div>)}
    {message && <p className="cfg-field__hint" role="status">{message}</p>}
  </section>;
}
