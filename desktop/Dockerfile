# grokbot-desktop: local replacement for the Orgo cloud desktop API.
FROM node:22-bookworm-slim AS node

FROM node AS deps
WORKDIR /app
COPY desktopd/package.json desktopd/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM debian:bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc xdotool x11-xserver-utils x11-utils imagemagick openbox \
      chromium fonts-dejavu fonts-noto-color-emoji fonts-liberation fonts-wqy-microhei \
      curl ca-certificates python3 git jq procps dbus-x11 tini xauth \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node

# `google-chrome` shim -> chromium (the server launches google-chrome ...). --test-type only hides the
# "unsupported command-line flag: --no-sandbox" infobar (chromedriver passes it too).
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --test-type "$@"\n' > /usr/local/bin/google-chrome \
    && chmod 755 /usr/local/bin/google-chrome \
    && ln -s /usr/local/bin/google-chrome /usr/local/bin/google-chrome-stable

# Non-root user; all ownership prepared at build time (container runs with --cap-drop ALL).
RUN useradd -m -u 1000 -s /bin/bash agent \
    && mkdir -p /home/agent/grokbot/profiles /home/agent/grokbot/files /home/agent/.config/openbox \
    && chown -R agent:agent /home/agent \
    && mkdir -p /tmp/.X11-unix /tmp/.ICE-unix && chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix

# Minimal openbox config: single desktop, no window decorations margin games.
COPY --chown=agent:agent openbox-rc.xml /home/agent/.config/openbox/rc.xml

COPY --from=deps /app/node_modules /opt/desktopd/node_modules
COPY desktopd/server.js desktopd/package.json /opt/desktopd/

USER agent
WORKDIR /home/agent
ENV HOME=/home/agent USER=agent RESOLUTION=1280x800x24 PORT=8090 LANG=C.UTF-8 LC_ALL=C.UTF-8
VOLUME ["/home/agent/grokbot"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:8090/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/desktopd/server.js"]
