#!/bin/sh
# Restore normal Docker networking by removing only this deployment's custom restrictions.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this script as root.' >&2; exit 1; }
for entry in INPUT:GROKBOT-INPUT DOCKER-USER:GROKBOT-EGRESS; do
  parent=${entry%:*}; chain=${entry#*:}
  while iptables -w -C "$parent" -i br-grokbot -j "$chain" 2>/dev/null; do
    iptables -w -D "$parent" -i br-grokbot -j "$chain"
  done
  if iptables -w -nL "$chain" >/dev/null 2>&1; then
    iptables -w -F "$chain"
    iptables -w -X "$chain"
  fi
done
for chain in INPUT FORWARD; do
  while ip6tables -w -C "$chain" -i br-grokbot -j DROP 2>/dev/null; do
    ip6tables -w -D "$chain" -i br-grokbot -j DROP
  done
done
