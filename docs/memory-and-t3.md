# Memory and native T3 connections

Bots have three separate kinds of context:

- Their current conversation, summarized automatically around a configurable 70,000 estimated tokens.
- Persistent native Bot memories. These survive a new conversation. Corrections replace an active fact; the prior version remains in an audit history. Forgotten memories leave active recall and prompts but retain an audit copy. Deleting the Bot removes its memory records.
- Approved read-only Codex knowledge. The app searches the actual Markdown files on demand and returns bounded, cited excerpts with source modification dates. Calling a model through a proxy alone does not load Codex memory.

The conversation meter shows progress toward summarization, not the model's context capacity. Measured input usage is persisted with the generation, model and history fingerprint so app restarts preserve it. Changed history invalidates the measurement; prompt/tool overhead is reserved explicitly. Without a valid measurement the estimate is conservative: encrypted reasoning byte length does not establish its real token cost, and the app does not assume another provider's compression ratio applies. A larger model window does not require carrying a larger conversation forever. After failed summarization, a conservative request guard stops excessive growth and offers recovery through **Summarize now** or a new conversation. Raw chat transcripts and persistent memories remain available.

## Configure sources and devices

Create `knowledge.json` next to the SQLite database, normally `data/knowledge.json`, with mode `600`. Override its location with `GROKBOT_KNOWLEDGE_CONFIG`. It is owner-managed configuration, never a model tool. Source/device grants use stable Bot IDs, not names. New Bots start without grants. Temporary helpers inherit the parent's grants and cannot widen them. Bot-message turns intersect the recipient's grants with the original sender chain, including through helpers, group forwarding and approval resumes; a restricted Bot cannot borrow the primary Bot's broader device/source access.

Example structure (replace IDs and paths):

```json
{
  "sources": [{
    "id": "codex-personal",
    "label": "Codex persistent knowledge",
    "root": "/home/you/.codex/memories_v2",
    "files": ["memory_summary.md", "rollout_summaries/*.md", "extensions/ad_hoc/notes/*.md"]
  }],
  "devices": [{
    "id": "workstation",
    "label": "Workstation T3",
    "url": "https://your-device.your-tailnet.ts.net/mcp"
  }],
  "grants": {
    "YOUR_PRIMARY_BOT_ID": {"sources": ["codex-personal"], "devices": ["workstation"]},
    "YOUR_PROJECT_BOT_ID": {"sources": [], "devices": []}
  }
}
```

Only exact Markdown paths and one-directory `/*.md` patterns are supported. Private Git directories, dot paths, parent traversal, outside-root symlinks, oversized files, and unlisted paths are denied. For a project Bot, make a separate source listing only approved project summaries. Do not grant the global summary if that Bot should not see other projects. Source changes are read on the next tool call; no stale duplicate index is maintained. Missing sources return no search hits; unapproved reads fail.

The server's account needs filesystem access to the approved roots. Keep credentials, Codex configuration, sessions, and raw private archives outside source allowlists. The bridge does not write or consolidate Codex-managed files. Treat source content as historical evidence and verify current permissions, service state, and code at their owning sources.

## Authenticate T3

Recommended: open **Bot settings → Memories → T3 devices**, select **Pairing link or code**, and paste a fresh pairing link from the running T3 app on that device. This targets the actual running nightly server and avoids an older CLI or another OS profile on your PATH. The owner-only pairing flow exchanges the code with PKCE, checks the callback state, and stores a dedicated MCP session. It never navigates the pasted URL; all requests go to the already approved device endpoint. The code is not saved as a memory or sent to the model. Use **Test connection** afterward.

Normal app/server updates preserve credentials in the private application configuration and the server's persistent T3 profile. Session expiry, revocation or a profile reset still requires pairing again. Current OAuth-issued sessions last 30 days. Pairing starts only through explicit owner controls; failed Bot authentication never opens an OAuth browser.

The app connects directly from its server. Desktop DNS and browser access are separate. Use an owner-approved private Tailscale endpoint; host-local HTTP is supported only for loopback addresses. URL credentials and redirects are rejected.

An HTTP 401 means the route is reachable but unauthenticated. A saved URL or an OAuth discovery document is not a connected MCP server.

Alternatively, on **each T3 device**, issue a separately revocable MCP client session. Ordinary API sessions do not work at `/mcp`: the subject must be `mcp-client`. On a CLI build whose help includes `--scope`:

```sh
t3 auth session issue --subject mcp-client \
  --scope orchestration:read --scope orchestration:operate \
  --ttl 30d --label grokbot --token-only
```

Use the CLI belonging to the running server and `--base-dir` if needed so it targets that server's profile. If the shell's CLI does not support the shown flags, use pairing from the running app. Omit `orchestration:operate` for a read-only connection. Never put tokens into Bot chat, memories, screenshots, Git, or URLs. Select **MCP access token** in the connection controls and paste the output there. The field is write-only, and the saved token is never sent to the model. You can also populate the private device object's `token` and optional Unix-millisecond `expiresAt` fields. Protect backups of this file as credentials.

The connection test performs authenticated MCP discovery and a harmless `t3_environment_read` call. Rejection does not trigger an OAuth browser or a client-signature workaround. Renew the token or fix server permissions. Review/revoke sessions on the issuing device:

```sh
t3 auth session list
t3 auth session revoke SESSION_ID
```

T3 also enforces the issued session's runtime ceiling; a CLI-issued MCP token may require approval for operations. Giving a Bot a device grant does not override that ceiling. App writes additionally follow the existing approval policy. Read tools use a fixed application allowlist, not server-supplied safety annotations. Changing grants takes effect on every call, including after an approval resumes. Cross-environment forwarding arguments are denied: choose a separately approved device instead. Device-linking and credential collection tools remain owner-side actions.

Native Bot tools are `list_mcp_devices`, `list_mcp_tools` and `mcp_call`. Large catalogs are bounded; search for the exact tool name to retrieve its schema. Calls validate arguments against the advertised schema, have transport time and response-size limits, redact the configured bearer token, and close the connection afterward. Tool errors are separate from successful execution; do not mark a task done merely because authentication worked.

For a user-requested new T3 thread, use `t3_thread_launch` with `scratch: true` or the intended `projectId`, an explicit requested model from that device's catalog, and a stable `clientRequestId`. Read the returned thread before reporting success. This app is a standalone MCP client: `delegate_task`, `create_threads`, `task_status` and `task_cancel` require an existing T3 parent-thread credential, so they are excluded from discovery here. Their `thread_credential_required` error does not mean normal thread launch is unavailable.

## Correct stale memories

Tell the Bot what changed. It can use `recall` to find IDs and `correct_memory` or `forget_memory` to update its own records. Settings → Memories also supports editing and forgetting. Normal `remember` saves are idempotent for exact matching active facts.

Durable preferences and project decisions do not expire merely with age. Temporary service/access state should be saved as `kind: observation`, which expires after seven days. Superseded, forgotten and expired facts are excluded from prompts, recall and automatic consolidation inputs. Consolidation proposes evidence-backed corrections for owner review instead of silently rewriting existing facts. Suggested corrections appear in Memories.

## Backups, recovery and checks

Before deploying a schema change, take a SQLite backup with the SQLite backup API. Keep the database, WAL files, private policy and credential backups out of Git. This migration is additive; older code would still read superseded memories, so a code-only rollback loses stale-memory filtering. To fully roll back, stop the app, preserve the current database and its WAL/SHM files, restore the pre-migration SQLite backup, restore the previous application build, and restart. Restoring an older backup loses subsequent writes, so reconcile them first.

```sh
node --import tsx --test tests/*.test.mjs
npm run typecheck
npm run build
```

Production dependency auditing is separate from the local development toolchain. Recheck credentials and connection tests after a token rotation, T3 upgrade, endpoint change or policy edit.
