#!/bin/sh
# Keep private device DNS entries available inside the desktop across container starts.
set -eu
[ -f /etc/grokbot/device-hosts ] || exit 0
docker exec -i -u 0 grokbot-desktop node -e '
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const entries = input.split("\n").filter(line => line.trim() && !line.trim().startsWith("#"));
  for (const entry of entries) {
    if (!/^\d+\.\d+\.\d+\.\d+\s+[a-zA-Z0-9.-]+(?:\s+[a-zA-Z0-9.-]+)*$/.test(entry)) throw Error("Invalid device host entry");
  }
  const path = "/etc/hosts";
  const old = fs.readFileSync(path, "utf8").replace(/\n?# BEGIN GROKBOT DEVICES\n[\s\S]*?# END GROKBOT DEVICES\n?/g, "\n");
  fs.writeFileSync(path, old.trimEnd() + "\n# BEGIN GROKBOT DEVICES\n" + entries.join("\n") + "\n# END GROKBOT DEVICES\n");
});
' < /etc/grokbot/device-hosts
