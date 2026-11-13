# Durable memory and native T3 MCP implementation plan

> **For implementers:** Apply the execution, TDD, and verification skills task by task. The owner has authorized implementation, deployment, and direct pushes to this fork; no PR is required.

**Goal:** Let Bots use their existing persistent memories alongside scoped, read-only Codex knowledge, correct outdated facts, and invoke authenticated T3 MCP tools across the owner's devices.

**Architecture:** Keep SQLite as the Bot memory store. Add a bounded filesystem retrieval adapter for Codex knowledge and a server-side MCP client for approved T3 endpoints. Access policy is enforced in code for each Bot and inherited by temporary helpers; model instructions and saved memories are not authorization controls. Keep credentials on the app server.

**Tech stack:** TypeScript, Node, Hono, SQLite, React, official MCP TypeScript SDK. Prefer existing queues, ownership helpers, tool registry, and configuration routes.

## Evidence and decisions

- The current clone compacts around 75,000 estimated tokens (300,000 characters), not a documented official Grok Bot threshold. Its meter measures progress toward compaction, not capacity remaining in the model.
- The installed Codex model catalog advertises `gpt-6-luna` with a 272,000 token context window and a 95% effective limit, approximately 258,400 tokens. This is local catalog evidence, not a guarantee for every proxy alias or fallback model. Preserve a conservative approximately 70k soft budget; do not increase it simply because the model supports more context.
- Current persistent memories are append-only. Consolidation can suppress similar additions but cannot supersede an incorrect old fact. Operational failures and obsolete capability claims can consequently remain in prompts.
- Codex memory lives outside this application. Calling a model through CLIProxyAPI does not run Codex's memory harness. Integrate the knowledge explicitly without editing Codex-generated memory files or importing credentials/configuration.
- Network routes have already been restored. An unauthenticated HTTP 401 from T3 proves reachability, not a working MCP connection. The application still needs initialization, authenticated tool discovery, and tool invocation.
- Existing public relay URLs previously returned Cloudflare 403/1010 for agent clients. Prefer owner-approved private Tailscale endpoints; do not work around the relay's client block.
- Preserve the owner's scope: the Seven Oceans Bot uses its assigned Thinkpad T3 server for that project. The primary Bot may have broader explicitly configured device access. New Bots receive no implicit grant to every device or Codex source.

## Review requested before implementation

Consult Gemini 4 Argon and OpenCode's GLM 5.3 Flash Free independently. Both should inspect owning code, research current primary documentation, challenge this proposal, identify missing acceptance checks, and return concrete changes. They should not edit production files, credentials, services, or memory stores. Record their findings and any unavailable capabilities honestly.

## Work and verification

Review update: GLM's independent review confirms the main design and requires explicit active-memory filtering, helper scope checks, persisted compaction failures, and bounded retrieval. Verified against npm and Context7: use the published `@modelcontextprotocol/client@2.4.0`, automatic protocol negotiation, non-interactive bearer auth, and transport teardown. The installed T3 CLI uses repeated `--scope` (singular), not `--scopes`; use the installed command's syntax. SSH authentication is currently unavailable on the linked remote devices, so do not assume remote token issuance works through SSH or reuse linked-session credentials. Remote connection setup must use an explicitly issued credential or the supported owner authentication flow.

Gemini review incorporated: persist measured token usage across process restarts with model/generation/history validation; account for prompt/tool overhead; keep server-side search calls with their completed response when compacting; label summarized failures as historical; repair stale standing instructions and task notes as well as memory rows; intersect sender/recipient authority through helpers, groups and approval resumes. Keep explicit observation expiry separate from durable facts. Do not apply the legacy xAI compaction compression ratio to Luna reasoning ciphertext without evidence. Current SDK 2.4.0 was independently verified and retained instead of Gemini's older v1 SDK suggestion.

Nightly integration finding: authenticated external MCP clients can use `t3_thread_launch` but cannot use thread-bound `delegate_task`/`create_threads`. Filter those unsupported tools and guide Bots to scratch/project launch. Verified Elitedesk's running nightly through an actual OpenRouter Free Models Router thread and completed reply. Add explicit owner pairing-code controls using the running app's PKCE OAuth endpoints, avoiding CLI build/profile mismatches; ordinary Bot calls remain headless bearer-only.

<task id="1" name="Source and device access policy" tdd="true">
  <files><create>server/src/knowledge-policy.ts</create><test>tests/knowledge-policy.test.mjs</test></files>
  <steps>
    <step>Write failing tests for wrong-owner access, unconfigured Bots, explicit allowed sources/devices, and helper inheritance.</step>
    <step>Implement a small server-owned policy with source identifiers and approved endpoint identifiers. Resolve helpers through their existing parent relationship, with cycle and owner checks.</step>
    <step>Keep local paths, device addresses, and credentials in ignored local configuration; do not let model tool arguments create access grants.</step>
  </steps>
  <verification><command>node --import tsx --test tests/knowledge-policy.test.mjs</command><expected>All scope tests pass; no grant can be gained through a Bot name, prompt, or arbitrary path.</expected></verification>
</task>

<task id="2" name="Bounded read-only Codex retrieval" tdd="true">
  <files><create>server/src/codex-memory.ts</create><modify>server/src/agent/tools.ts</modify><modify>server/src/agent/prompt.ts</modify><test>tests/codex-memory.test.mjs</test></files>
  <steps>
    <step>Write temporary-directory tests for relevant retrieval with source paths and dates, allowed source subsets, missing files, malformed inputs, path traversal, symlinks, and bounded output.</step>
    <step>Read only approved Markdown knowledge files under configured Codex memory roots. Exclude configuration, sessions, credential stores, Git internals, and arbitrary home-directory files.</step>
    <step>Expose native search/read tools with server-side authorization on every call. Add a compact source guide to prompts, then retrieve relevant evidence on demand instead of injecting the whole archive.</step>
    <step>Mark retrieved facts as historical evidence, with a requirement to verify consequential current state at the owning source. Refresh from files without copying an indefinitely stale second archive.</step>
  </steps>
  <verification><command>node --import tsx --test tests/codex-memory.test.mjs</command><expected>Relevant excerpts have provenance; denied sources and filesystem escapes return no content; limits hold.</expected></verification>
</task>

<task id="3" name="Correctable native memories" tdd="true">
  <files><modify>server/src/db-config.ts</modify><modify>server/src/agent/memory.ts</modify><modify>server/src/agent/tools.ts</modify><modify>server/src/routes-config.ts</modify><modify>server/src/types.ts</modify><test>tests/memory.test.mjs</test></files>
  <steps>
    <step>Write failing tests for idempotent saves, explicit correction and forgetting, wrong-Bot mutation, superseded facts excluded from recall/prompt, and preservation of unrelated facts.</step>
    <step>Add minimal lifecycle metadata and an audit trail for corrections. Return memory IDs to Bots so they can update or forget their own facts deliberately.</step>
    <step>Distinguish durable preferences/project decisions from temporary observed state. Carry observation dates and allow expiry/revalidation for operational claims; do not delete project knowledge merely because it is old.</step>
    <step>Allow consolidation to propose evidence-backed corrections without treating absence of a fact as permission to erase it. Avoid silent destructive model-authored bulk rewrites.</step>
  </steps>
  <verification><command>node --import tsx --test tests/memory.test.mjs</command><expected>Corrections replace active facts with a recoverable history; other Bots and unrelated project memories are untouched.</expected></verification>
</task>

<task id="4" name="Authenticated T3 MCP client" tdd="true">
  <files><create>server/src/t3-mcp.ts</create><modify>server/package.json</modify><modify>server/src/agent/tools.ts</modify><modify>server/src/agent/prompt.ts</modify><test>tests/t3-mcp.test.mjs</test></files>
  <steps>
    <step>Use Context7/current official SDK documentation and select a compatible published stable SDK version.</step>
    <step>Write local mock-server tests covering initialization, tool catalog pagination, invocation, scoped denial before network access, HTTP 401/403, timeout, malformed responses, and credential redaction.</step>
    <step>Connect from the application host using Streamable HTTP and separately issued scoped T3 bearer credentials. Never reuse this assistant's linked-device session credentials.</step>
    <step>Provide bounded native discovery/call tools, enforce device grants on every invocation, validate tool arguments against server schemas, and integrate existing approval policy for operations rather than implicitly allowing all remote tools.</step>
    <step>Return explicit connection/authentication errors, close transports, cap response size and request time, and never inject bearer tokens into model context or UI responses.</step>
  </steps>
  <verification><command>node --import tsx --test tests/t3-mcp.test.mjs</command><expected>Authenticated initialize/list/call succeeds and all negative authorization, credential, and transport checks pass.</expected></verification>
</task>

<task id="5" name="Connection and memory controls" tdd="true">
  <files><modify>server/src/routes-config.ts</modify><modify>web/src/configStore.ts</modify><modify>web/src/components/config/BotSettingsModal.tsx</modify><modify>server/src/types.ts</modify><test>tests/knowledge-api.test.mjs</test></files>
  <steps>
    <step>Add owner-authenticated status/configuration routes with input validation and tests for anonymous and wrong-owner requests. Secrets must be write-only.</step>
    <step>Show enabled knowledge sources, usable devices, auth failures, and a connection test. Support deliberate memory correction and forgetting without requiring shell access.</step>
    <step>Label the conversation meter as estimated progress toward automatic summarization; show the threshold and last compaction/error separately from persistent memory counts.</step>
  </steps>
  <verification><command>node --import tsx --test tests/knowledge-api.test.mjs</command><expected>No secret is readable through API responses; ownership and invalid-input checks pass.</expected></verification>
</task>

<task id="6" name="Compaction reliability" tdd="true">
  <files><modify>server/src/agent/memory.ts</modify><modify>server/src/agent/loop.ts</modify><modify>server/src/routes-config.ts</modify><test>tests/compaction.test.mjs</test></files>
  <steps>
    <step>Write failing tests for approximately 70k soft-budget triggering, paired tool history, retention of current instructions/tasks, failed summaries, and fallback model selection.</step>
    <step>Keep a configurable conservative soft threshold; account for prompt/tool overhead and output reserve where reliable model metadata exists. Do not claim heuristic estimates are exact token counts.</step>
    <step>Persist useful compaction success/error status and guard oversized requests when summarization fails instead of silently continuing forever beyond a known safe bound.</step>
    <step>Keep raw user-facing transcript and durable memories intact. Preserve summary provenance and avoid repeatedly elevating stale operational failures into permanent instructions.</step>
  </steps>
  <verification><command>node --import tsx --test tests/compaction.test.mjs</command><expected>Oversized histories summarize safely, failures are visible and recoverable, and function calls retain matching outputs.</expected></verification>
</task>

<task id="7" name="Local configuration and verified stale-fact repair">
  <files><modify>.env.example</modify><modify>README.md</modify><create>docs/memory-and-t3.md</create></files>
  <steps>
    <step>Back up the SQLite database before migrations and record a rollback procedure. Keep backups and local source/device policy out of Git.</step>
    <step>Configure primary-Bot access and the Seven Oceans project subset with actual stable Bot IDs. Use individually revocable T3 sessions with explicit scopes and expiry.</step>
    <step>Verify authentication and a harmless tool call on each device. If remote credential issuance is unavailable, complete the connection flow and identify the exact owner action still needed; do not report HTTP 401 as success.</step>
    <step>Correct the known obsolete native-Bot capability statement and distinguish the old public relay failure from current private-device connectivity. Preserve the underlying Seven Oceans project facts and record the correction reason.</step>
  </steps>
  <verification><expected>Each reported-connected device has completed initialize, tool listing, and one authorized harmless call; project scope and stale-memory fixes are demonstrated.</expected></verification>
</task>

<task id="8" name="Integration verification and delivery">
  <steps>
    <step>Run all focused tests, existing Bot/model/task tests, typecheck, build, and diff checks. Review authentication, source scoping, secret handling, dependencies, and simplification.</step>
    <step>Deploy the user service, verify health and a temporary Bot end-to-end, and remove test records. Verify authorized retrieval succeeds and forbidden device access is denied at runtime.</step>
    <step>Push reviewed changes directly to the owner's public fork main branch and report actual tested outcomes, remaining credential actions, consultation findings, and rollback instructions.</step>
  </steps>
  <verification><command>node --import tsx --test tests/*.test.mjs &amp;&amp; npm run typecheck &amp;&amp; npm run build &amp;&amp; git diff --check</command><expected>All checks pass; live API and service checks pass after deployment.</expected></verification>
</task>

## Primary references to verify during implementation

- https://docs.x.ai/grok-bot/bots — official Bot memory behavior; internal thresholds are not specified.
- https://github.com/openai/codex/tree/main/codex-rs/memories — Codex extraction/consolidation and retrieval design.
- https://github.com/modelcontextprotocol/typescript-sdk — supported MCP client transport/authentication interfaces.
- Installed `t3 auth session issue --help` — explicit scoped, expiring, revocable headless credentials.

## Long-term maintenance

Keep sources separate, preserve provenance, and revalidate volatile facts. Use per-device revocable sessions with visible expiry/auth status. Treat memory as evidence rather than the current source of truth. Retain bounded retrieval and conservative summarization even on larger models; adjust budgets from measured usage and verified provider metadata. Avoid adding a vector database or a second memory-writing agent until actual retrieval quality requires one.
