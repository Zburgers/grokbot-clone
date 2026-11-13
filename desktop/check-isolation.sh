#!/bin/sh
# Prints which destinations the grokbot-desktop container can reach. Expect: internet OK, everything else BLOCKED.
failed=0
probe() { # name url expected
  if docker exec grokbot-desktop curl -s -o /dev/null -m 4 "$2" 2>/dev/null; then
    echo "REACHABLE  $1 ($2)"
    [ "${3:-blocked}" = reachable ] || failed=1
  else
    echo "blocked    $1 ($2)"
    [ "${3:-blocked}" = blocked ] || failed=1
  fi
}
probe "internet"            https://example.com reachable
probe "host CLIProxyAPI"    http://10.0.20.1:8317/v1/models
probe "host via LAN IP"     http://192.168.29.14:8317/v1/models
probe "host grokbot server" http://10.0.20.1:8787/api/health
probe "LAN router"          http://192.168.29.1/
probe "tailscale host"      http://100.87.104.100:8317/
probe "coolify network"     http://10.0.1.1:8000/
probe "docker0 gateway"     http://10.0.0.1:8317/
probe "cloud metadata"      http://169.254.169.254/

exit "$failed"
