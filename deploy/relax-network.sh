#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
cd "$(dirname "$0")"
install -d -m 755 /usr/local/libexec/grokbot /etc/grokbot
install -m 755 desktop-firewall.sh /usr/local/libexec/grokbot/desktop-firewall.sh
install -m 755 desktop-hosts.sh /usr/local/libexec/grokbot/desktop-hosts.sh
install -m 644 device-hosts /etc/grokbot/device-hosts
install -m 644 grokbot-desktop.service /etc/systemd/system/grokbot-desktop.service
/usr/local/libexec/grokbot/desktop-firewall.sh
if [ "$(docker inspect grokbot-desktop --format '{{.State.Running}}')" = true ]; then
  /usr/local/libexec/grokbot/desktop-hosts.sh
fi
systemctl daemon-reload
echo 'Normal Docker outbound networking restored; private device names configured.'
