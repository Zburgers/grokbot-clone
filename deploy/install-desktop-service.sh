#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
cd "$(dirname "$0")"
# Stop before changing rules; failed installation leaves the desktop stopped.
docker update --restart=no grokbot-desktop >/dev/null
docker stop -t 20 grokbot-desktop >/dev/null
install -d -m 755 /usr/local/libexec/grokbot
install -m 755 desktop-firewall.sh /usr/local/libexec/grokbot/desktop-firewall.sh
install -m 644 grokbot-desktop.service /etc/systemd/system/grokbot-desktop.service
systemctl daemon-reload
systemctl enable grokbot-desktop.service
systemctl restart grokbot-desktop.service
if ! ../desktop/check-isolation.sh; then
  systemctl stop grokbot-desktop.service
  echo 'Isolation verification failed; desktop stopped.' >&2
  exit 1
fi
