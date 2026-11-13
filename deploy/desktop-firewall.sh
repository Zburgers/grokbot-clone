#!/bin/sh
# Root only. Rules affect traffic originating at the dedicated agent bridge.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this script as root.' >&2; exit 1; }
iptables -w -nL DOCKER-USER >/dev/null
for chain in GROKBOT-INPUT GROKBOT-EGRESS; do
  iptables -w -nL "$chain" >/dev/null 2>&1 || iptables -w -N "$chain"
  iptables -w -F "$chain"
  iptables -w -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done
iptables -w -A GROKBOT-INPUT -j DROP
for subnet in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -w -A GROKBOT-EGRESS -d "$subnet" -j DROP
done
iptables -w -A GROKBOT-EGRESS -j RETURN
iptables -w -C INPUT -i br-grokbot -j GROKBOT-INPUT 2>/dev/null || iptables -w -I INPUT 1 -i br-grokbot -j GROKBOT-INPUT
iptables -w -C DOCKER-USER -i br-grokbot -j GROKBOT-EGRESS 2>/dev/null || iptables -w -I DOCKER-USER 1 -i br-grokbot -j GROKBOT-EGRESS
# This desktop network has IPv6 disabled; also fail closed if IPv6 is enabled later.
ip6tables -w -C INPUT -i br-grokbot -j DROP 2>/dev/null || ip6tables -w -I INPUT 1 -i br-grokbot -j DROP
ip6tables -w -C FORWARD -i br-grokbot -j DROP 2>/dev/null || ip6tables -w -I FORWARD 1 -i br-grokbot -j DROP
