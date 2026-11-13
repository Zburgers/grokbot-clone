# Personal Linux deployment

The configured app runs as a `grokbot.service` user service and listens on localhost:8787.
Create that user unit for your checkout using Node with `--env-file=../.env dist/index.js`
and the server workspace as its working directory, then enable it with `systemctl --user enable --now grokbot.service`.
Use your own tailnet hostname below. Configure `APP_URL` and `SERVER_URL` to match it.
Run `tailscale serve --bg --https=10443 http://127.0.0.1:8787` to create the private route.
Private URL: https://your-server.your-tailnet.ts.net:10443/
Tailscale Serve is persistent and tailnet-only on that port; no Funnel is configured for this app.

Configuration and secrets are in the ignored, owner-only `.env`. The initial owner password is
in `data/owner-password.txt` (mode 600). Voice and Google login are disabled; Composio remains enabled
for app connections. GPT-6 Luna is selected through the existing localhost CLIProxyAPI endpoint,
with the configured Gemini fallback. Availability depends on those accounts and their quotas.

## Desktop networking

The desktop uses normal Docker outbound networking, including the host, LAN, and Tailscale routes.
`desktop-firewall.sh` removes the deployment's old custom private-network restrictions. It does
not flush unrelated host firewall rules. The non-root desktop and its named volume remain in Docker.

To update an existing deployment to normal networking:

```sh
sudo ./deploy/relax-network.sh
```

Create a local ignored `deploy/device-hosts` file first, with one IPv4 address followed by its
private device hostname (and optional aliases) per line. The installer copies this to
`/etc/grokbot/device-hosts`. The service restores these mappings inside the desktop at each start,
since public DNS does not resolve private tailnet names reliably. This file contains addresses,
not credentials. Use the real addresses reported by `tailscale status` on your own network.

A Tailscale Serve listener can be bound specifically to the Tailscale interface and may not
accept connections originating on a local Docker bridge. For the T3 server on the same host,
its direct API (for example `http://<host-name>:3773/mcp`) can be reached from the desktop when
the T3 server is configured to listen on the host network. Remote devices can use their private
HTTPS MCP URLs. Verify the actual bind address and port before using either route.

Private MCP connectivity still requires a supported MCP client and server authentication.
Remembering a URL does not register an MCP connection. HTTP 401 means the server was reached and
requires credentials; connection timeouts indicate a routing, DNS, firewall, or service issue.

## Operations

```sh
systemctl --user status grokbot.service
systemctl --user restart grokbot.service
sudo systemctl status grokbot-desktop.service
desktop/check-isolation.sh
```

After source changes, run `npm run typecheck` and `npm run build`, then restart the app.
Do not run `desktop/test.sh` against this deployment: it creates a separate test container on the
same published port and does not apply the deployment's network isolation rules.
