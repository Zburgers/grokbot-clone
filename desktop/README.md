# grokbot-desktop

Local, self-hosted replacement for the Orgo cloud desktop API. One container = one "computer":
Xvfb + openbox + x11vnc per screen, Chromium (as `google-chrome`), and **desktopd** (Node 22, `ws` only)
serving an Orgo-compatible HTTP + WebSocket API on port 8090.

## Build & run

```bash
docker build -t grokbot-desktop:local desktop/
docker run -d --name grokbot-desktop \
  -e DESKTOP_TOKEN=change-me \
  -p 127.0.0.1:8090:8090 \
  -v grokbot-desktop-data:/home/agent/grokbot \
  --shm-size 1g --memory 2.5g --cpus 2 --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges \
  grokbot-desktop:local
desktop/test.sh /tmp/out   # smoke test (uses its own throwaway container on 127.0.0.1:18090)
```

Env: `DESKTOP_TOKEN` (required), `RESOLUTION` (default `1280x800x24`), `VNC_PASSWORD` (optional, else random 8 chars per start),
`BACKGROUND_COLOR` (default `#2b3a4a`). Runs as `agent` (uid 1000); `/home/agent/grokbot` (browser `profiles/`, `files/`) is a volume.

## Screens

| screen id  | X display | x11vnc port (127.0.0.1, in-container) |
|------------|-----------|----------------------------------------|
| `default`  | `:99`     | 5999                                   |
| `screen-N` | `:N`      | 5900+N (N = 1..3)                      |

Max 4 screens. VNC uses VNC auth (security type 2) with the password from `GET /vnc-password`.
Crashed Xvfb/openbox/x11vnc processes are restarted automatically (exponential backoff) and on demand.

## API

All routes except `GET /health` and the WebSocket need `Authorization: Bearer $DESKTOP_TOKEN`.
`?screen=` selects a screen (absent/`default` → `:99`); unknown → 404. Errors are `{error}`.

| Route | Body / params | Response |
|-------|---------------|----------|
| `GET /health` | | `{ok:true}` |
| `GET /computer` | | `{id:"local",status:"running",name:"local",resolution}` |
| `GET /vnc-password` | | `{password, desktop_api_token:""}` |
| `GET/POST /screens` | | `{screens:[…]}` / new screen (409 at max) |
| `GET/DELETE /screens/:id` | | screen `{id,display,width,height,default}` / `{success}` (400 for default) |
| `GET /screenshot` | `screen` | `{image:<base64 jpeg>, mime_type, width, height}` |
| `POST /click` | `{x,y,button?,double?}` | `{success:true}` |
| `POST /mouse-move` | `{x,y}` | |
| `POST /drag` | `{start_x,start_y,end_x,end_y}` | |
| `POST /type` | `{text}` | |
| `POST /key` | `{key}` e.g. `ctrl+l`, `enter`, `ctrl+shift+t` | |
| `POST /scroll` | `{x,y,direction:'up'\|'down',amount}` | |
| `POST /bash` | `{command, timeout?=120 (max 300)}` | `{success,output,exit_code}` (124 on timeout) |
| `GET /files` | `path=/abs/path` (must resolve inside `/home/agent`) | raw bytes; 403 / 404 |
| `WS /websockify` | `token=<vnc password>&screen=<id>`, subprotocol `binary` | raw RFB bridge to x11vnc |

`/bash` runs `bash -lc` as `agent` in `/home/agent` with `DISPLAY` of the chosen screen; it returns as soon as the
main process exits (background jobs survive; use `setsid nohup … &` for long-lived apps).
