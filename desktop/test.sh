#!/usr/bin/env bash
# Smoke test for grokbot-desktop. Usage: desktop/test.sh [OUT_DIR]
# Builds nothing; expects image grokbot-desktop:local. Starts/removes container grokbot-desktop-test.
set -uo pipefail
cd "$(dirname "$0")"
OUT=${1:-/tmp/grokbot-desktop-test}
mkdir -p "$OUT"
NAME=grokbot-desktop-test
TOKEN=testtoken
BASE=http://127.0.0.1:18090
KEEP=${KEEP:-0}
pass=0; fail=0
ok()  { echo "PASS  $*"; pass=$((pass+1)); }
bad() { echo "FAIL  $*"; fail=$((fail+1)); }
check() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
match() { [[ $1 =~ $2 ]]; }
api() { local m=$1 p=$2; shift 2; curl -sS -X "$m" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@" "$BASE$p"; }
code() { local m=$1 p=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X "$m" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@" "$BASE$p"; }
shot() { api GET "/screenshot$1" | jq -r .image | base64 -d > "$2"; }
dims() { local f; f=$(file -b "$1"); [[ $f == JPEG* ]] && echo "JPEG $(grep -oE ", [0-9]+x[0-9]+," <<<"$f" | tr -d ", ")"; }

docker rm -f $NAME >/dev/null 2>&1
docker run -d --name $NAME -e DESKTOP_TOKEN=$TOKEN -p 127.0.0.1:18090:8090 --shm-size 1g --memory 2.5g --cpus 2 \
  --pids-limit 512 --cap-drop ALL --security-opt no-new-privileges grokbot-desktop:local >/dev/null || exit 1
[ "$KEEP" = 1 ] || trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT
for i in $(seq 60); do curl -fs $BASE/health >/dev/null && break; sleep 0.5; done

check "health" test "$(curl -s $BASE/health | jq -r .ok)" = true
check "401 without bearer" test "$(curl -s -o /dev/null -w '%{http_code}' $BASE/screens)" = 401
check "401 bad bearer" test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' $BASE/screens)" = 401
check "computer" test "$(api GET /computer | jq -r .status)" = running
check "screens list" test "$(api GET /screens | jq -c '.screens[0]')" = '{"id":"default","display":":99","width":1280,"height":800,"default":true}'
shot "" "$OUT/desktop_test.jpg"
check "screenshot jpeg 1280x800" test "$(dims "$OUT/desktop_test.jpg")" = "JPEG 1280x800"
R=$(api POST /bash -d '{"command":"id -un && echo $DISPLAY"}')
check "bash id/DISPLAY" test "$(echo "$R" | jq -r .output)" = $'agent\n:99'
check "bash exit code" test "$(api POST /bash -d '{"command":"exit 3"}' | jq -c '[.success,.exit_code]')" = '[false,3]'
check "bash timeout 124" test "$(api POST /bash -d '{"command":"echo hi; sleep 30","timeout":1}' | jq -c '[.exit_code,.output]')" = '[124,"hi\n"]'
T0=$(date +%s%N)
api POST /bash -d '{"command":"setsid nohup google-chrome --no-sandbox --no-first-run --disable-dev-shm-usage --user-data-dir=/home/agent/grokbot/profiles/t --start-maximized https://example.com >/dev/null 2>&1 &"}' >/dev/null
MS=$(( ($(date +%s%N) - T0) / 1000000 ))
check "bash bg chrome returns promptly (${MS}ms)" test $MS -lt 3000
T0=$(date +%s%N)
api POST /bash -d '{"command":"sleep 20 &"}' >/dev/null   # inherits our pipes
MS=$(( ($(date +%s%N) - T0) / 1000000 ))
check "bash bg job holding pipes returns promptly (${MS}ms)" test $MS -lt 3000
sleep 8
shot "" "$OUT/desktop_chrome.jpg"
check "chrome running" test "$(api POST /bash -d '{"command":"pgrep -c chromium"}' | jq -r '.output|tonumber > 0')" = true
check "click 200" test "$(code POST /click -d '{"x":640,"y":400}')" = 200
check "double click 200" test "$(code POST /click -d '{"x":640,"y":400,"button":"left","double":true}')" = 200
check "type 200" test "$(code POST /type -d '{"text":"héllo 👋\nworld"}')" = 200
check "key ctrl+l 200" test "$(code POST /key -d '{"key":"ctrl+l"}')" = 200
check "key enter alias 200" test "$(code POST /key -d '{"key":"esc"}')" = 200
check "scroll 200" test "$(code POST /scroll -d '{"x":640,"y":400,"direction":"down","amount":3}')" = 200
check "drag 200" test "$(code POST /drag -d '{"start_x":100,"start_y":100,"end_x":300,"end_y":300}')" = 200
check "move 200" test "$(code POST /mouse-move -d '{"x":10,"y":10}')" = 200
check "bad screen 404" test "$(code GET '/screenshot?screen=screen-9')" = 404
check "create screen-1" test "$(api POST /screens | jq -c '[.id,.display]')" = '["screen-1",":1"]'
shot "?screen=screen-1" "$OUT/desktop_screen1.jpg"
check "screen-1 screenshot" test "$(dims "$OUT/desktop_screen1.jpg")" = "JPEG 1280x800"
check "screen-1 bash DISPLAY" test "$(api POST '/bash?screen=screen-1' -d '{"command":"echo $DISPLAY"}' | jq -r .output)" = ':1'
api POST /screens >/dev/null; api POST /screens >/dev/null
check "max screens 409" test "$(code POST /screens)" = 409
check "delete default 400" test "$(code DELETE /screens/default)" = 400
check "delete screen-3" test "$(code DELETE /screens/screen-3)" = 200
check "get deleted 404" test "$(code GET /screens/screen-3)" = 404
api POST /bash -d '{"command":"echo filedata > /home/agent/grokbot/files/t.txt"}' >/dev/null
check "files read" test "$(api GET '/files?path=/home/agent/grokbot/files/t.txt')" = filedata
check "files /etc/passwd 403" test "$(code GET '/files?path=/etc/passwd')" = 403
api POST /bash -d '{"command":"ln -sf /etc/passwd /home/agent/pw"}' >/dev/null
check "files symlink escape 403" test "$(code GET '/files?path=/home/agent/pw')" = 403
check "files missing 404" test "$(code GET '/files?path=/home/agent/nope')" = 404
PW=$(api GET /vnc-password | jq -r .password)
check "vnc password 8 chars" test ${#PW} = 8
WSOUT=$(docker exec -e PW="$PW" -w /opt/desktopd $NAME node -e '
const WebSocket = require("ws");
const ws = new WebSocket(`ws://127.0.0.1:8090/websockify?token=${process.env.PW}&screen=default`, ["binary"]);
const t = setTimeout(() => { console.log("timeout"); process.exit(1); }, 5000);
ws.on("message", (d) => { console.log(ws.protocol, JSON.stringify(d.toString())); clearTimeout(t); ws.close(); process.exit(0); });
ws.on("error", (e) => { console.log("error", e.message); process.exit(1); });')
check "websockify banner ($WSOUT)" match "$WSOUT" '^binary "RFB 003\.00[0-9]\\n"$'
WSBAD=$(docker exec -w /opt/desktopd $NAME node -e '
const ws = new (require("ws"))("ws://127.0.0.1:8090/websockify?token=wrong", ["binary"]);
ws.on("open", () => { console.log("open"); process.exit(0); });
ws.on("error", (e) => { console.log(e.message); process.exit(0); });')
check "websockify bad token rejected ($WSBAD)" match "$WSBAD" 401
docker stats --no-stream --format 'stats: mem {{.MemUsage}} cpu {{.CPUPerc}} pids {{.PIDs}}' $NAME
echo "screenshots in $OUT"
echo "passed=$pass failed=$fail"
[ $fail = 0 ]
