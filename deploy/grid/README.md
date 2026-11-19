# hivebot on the HiveMind Grid

Pilot deployment of [`HiveMind-Network-Ltd/hivebot`](https://github.com/HiveMind-Network-Ltd/hivebot)
(a fork of [`Zburgers/grokbot-clone`](https://github.com/Zburgers/grokbot-clone), MIT) as a
**standard Docker workload on `hm-grid-01`**. It is not a Desk companion app, is not embedded in
Desk, and does not use BIOS SSO. Tracked in [HIVA-26487](/HIVA/issues/HIVA-26487).

## What runs

| Service | Image | Port | Reachable? |
|---|---|---|---|
| `hivebot` | `ghcr.io/hivemind-network-ltd/hivebot` (root `Dockerfile`) | 8787 | `100.71.130.57:8787` over the tailnet, and nothing else |
| `hivebot-desktop` | `ghcr.io/hivemind-network-ltd/hivebot-desktop` (`desktop/Dockerfile`, unchanged upstream) | 8090 | Only from `hivebot`, over `hivebot-net` |

The app never touches the Docker socket. Screenshots, clicks, typing, shell and file transfer are
all HTTP/WebSocket calls to the desktop daemon. That keeps the credential split meaningful: the
routed container holds the model key, Composio key and owner password hash but cannot execute a
command; the container that executes commands holds only `DESKTOP_TOKEN`.

## Why there is no Traefik route yet

By Lyndon's decision the pilot is **tailnet-only**: a single tester, no public surface. The port
binding is `100.71.130.57:8787`, never `0.0.0.0`, so there is no public listener to misconfigure.
There is no DNS record, no certificate and no router.

Public cutover later is three steps, in this order:

1. Create the explicit `A` record `hivebot.hivemindnetwork.com -> 54.246.163.98` (and no `AAAA`).
   The `*.hivemindnetwork.com` wildcard currently points at `52.51.27.9`, so a certificate
   request before this step fails HTTP-01.
2. Add the four router labels to the `hivebot` service (both `-web` and `websecure` routers,
   `le-http` resolver, service port 8787), drop the `ports:` binding, and set `domain` in
   `params.json`.
3. Change `APP_URL`/`SERVER_URL` to `https://hivebot.hivemindnetwork.com` and recreate the
   container. The session cookie is only marked `Secure` when `APP_URL` starts with `https`, so
   this step must not be skipped or reordered.

Widening access to other people is a separate decision. The app is single-tenant: one owner row,
and every bot shares one desktop container and one set of browser profiles. Adding users without
per-user isolation would share that computer across them.

## Deploying

The repository workflow builds both images and calls
`POST https://deploy.grid.hivemindnetwork.com/deploy/hivebot`. Deployment is gated on the
repository variable `HIVEBOT_DEPLOY_ENABLED`; leave it unset until `apps/hivebot/params.json` has
merged in `hive-deploy-infra` and `/admin/reload` has rendered the fragment. Before that, no
`hivebot` service exists to recreate.

Order of operations:

1. Merge the `hive-deploy-infra` change: `apps/hivebot/params.json`, plus `hivebot-net` in
   `templates/compose-header.yml` networks and `hivebot-data` / `hivebot-desktop-data` in its
   volumes.
2. Place both env files on the host (below) — before the first deploy, so the container never
   starts half-configured.
3. Set `HIVEBOT_DEPLOY_ENABLED=true`, dispatch the workflow once.
4. Verify (next section), then pin the deployed image by digest rather than tracking `:latest`.

### Operator files

Both are mode 640, `deploy:deploy`, and are never committed:

| Path | Read by | Contents |
|---|---|---|
| `/srv/stack/hivebot/.env` | `hivebot` | everything in [`env.example`](./env.example) |
| `/srv/stack/hivebot/desktop.env` | `hivebot-desktop` | `DESKTOP_TOKEN` only (must match) |

`OWNER_PASSWORD_HASH` is generated with `node scripts/hash-password.mjs < password-file` and
pasted in **single quotes** so the `$` separators stay literal. Generate it on a workstation, not
on the host.

## Verification

A deploy that returns 200 is not evidence the app works. Check, in order:

1. `curl -fsS http://100.71.130.57:8787/api/health` from another tailnet device → 200.
2. Model: run the probe against DeepSeek from inside the container —
   `docker exec prod-stack-hivebot-1 node server/probe-llm.mjs deepseek-flash`. It exercises a
   basic turn, a function call, image-in-tool-output and `reasoning.encrypted_content`. DeepSeek
   rejects reasoning effort `minimal` with HTTP 400, and answers some request shapes differently
   from xAI, so this is the gate rather than an assumption.
3. Log in with the owner password; open a bot and complete one chat turn.
4. Give a bot a browser task and watch it in the viewer — this proves the desktop link, the VNC
   relay and the WebSocket path through the port binding.
5. Confirm the event stream stays open (SSE) for a couple of minutes; no idle proxy timeout
   applies on a direct binding.
6. `docker exec prod-stack-hivebot-1 node -e "fetch('http://100.71.130.57:8443').then(()=>console.log('REACHED')).catch(()=>console.log('blocked'))"`
   → `blocked`. Container → tailnet egress is default-denied; if this reaches anything, the guard
   is not covering this container.

## Constraints worth remembering

- **One replica.** SQLite WAL, an in-process cron scheduler for routines/triggers and an in-memory
  login-failure counter all assume a single process. Do not scale.
- **No build here.** Images are built in GitHub Actions; the host only pulls.
- **Disk.** The desktop image is large (Chromium + X11). Check headroom before the first pull —
  the Grid has a history of disk pressure.
- **Upstream drift.** `deploy/grid/` is ours; everything else tracks `upstream`. Do not "fix"
  upstream files in place — that makes every future merge a conflict. The one exception is the
  one-line `LLM_BASE_URL` default in `server/probe-llm.mjs`, which is upstream-shaped and
  intended to be offered back.
