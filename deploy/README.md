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

## Finish desktop isolation (root required)

From the project root:

```sh
sudo ./deploy/install-desktop-service.sh
```

The installer stops the desktop, installs a systemd unit and a root-owned firewall script, applies
rules, then starts and verifies the desktop. It leaves the desktop stopped if verification fails.
The container uses `restart=no`: the system unit applies firewall rules before starting it at boot.
Rules affect only traffic originating on `br-grokbot`, preserving responses to host-initiated API
connections. New connections to host services and private networks are blocked, public IPv4 internet
access is retained, and IPv6 from that bridge is blocked. Docker's existing rules are not flushed.
The desktop has no host bind mounts, Docker socket, or extra capabilities.

Until this step succeeds, text chat works but computer tools are unavailable.

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
