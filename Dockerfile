FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    AZURE_CONFIG_DIR=/config/azure \
    AZURE_MCP_COLLECT_TELEMETRY=false \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release apt-transport-https tini libicu72 \
 && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/azure-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends azure-cli \
 && rm -rf /var/lib/apt/lists/*

# MCP servers and stdio->SSE bridge
RUN npm install -g --no-audit --no-fund \
      @azure/mcp@latest \
      @azure-devops/mcp@latest \
      supergateway@latest

# Vendor htmx at build time so the container has no runtime CDN dependency
RUN mkdir -p /app/public \
 && curl -fsSL -o /app/public/htmx.min.js https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js

WORKDIR /app
COPY app/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY app/src ./src
COPY app/views ./views
COPY app/public/styles.css ./public/styles.css
COPY app/public/sse.js ./public/sse.js
COPY app/public/tubesnob-icon.jpeg ./public/tubesnob-icon.jpeg

RUN mkdir -p /config /logs

EXPOSE 19900 19901 19902
VOLUME ["/config", "/logs"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
