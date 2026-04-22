# Azure MCP Bundle

A single Docker image (`tubesnob-azuremcp`) that embeds:

- **Azure MCP Server** — [`@azure/mcp`](https://www.npmjs.com/package/@azure/mcp)
- **Azure DevOps MCP Server** — [`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp)
- A **management web UI** to start/stop/restart each server, edit configuration, view live logs and stats, and sign in to Azure via device code.
- A **stdio→SSE bridge** ([`supergateway`](https://github.com/supercorp-ai/supergateway)) so remote MCP clients can connect over HTTP.

Both MCP servers share a single `az login` session, so one device-code sign-in authenticates both.

## Purpose

This container packages the `@azure/mcp` and `@azure-devops/mcp` Model Context Protocol servers, a small management UI, and the Azure CLI into one image. The goal is to let an MCP-aware client (Claude Code, the VS Code MCP extension, etc.) talk to Azure resources and Azure DevOps projects over a stable SSE endpoint without needing a per-host Node/Azure-CLI install on every machine that runs the client.

## How it works internally

The container runs a Fastify-based supervisor process (this UI, port `19900`). The supervisor launches the upstream MCP servers as child processes and wraps each one with [`supergateway`](https://github.com/supercorp-ai/supergateway), which bridges the server's stdio MCP transport to an SSE transport on a dedicated port:

- **Port 19901** — Azure MCP (`@azure/mcp`)
- **Port 19902** — Azure DevOps MCP (`@azure-devops/mcp`)

Azure authentication is handled by the bundled Azure CLI using the device-code flow. The resulting token cache is stored in `/config/azure`, which `docker-compose.example.yml` mounts from `~/.azureMCPContainer/config` so the login survives container restarts and image rebuilds. Child-process state, restarts, CPU/RSS stats, and per-server log tailing (via `rotating-file-stream`) are managed by the supervisor and surfaced to the UI through htmx partials and an SSE stream.

## Ports

| Port | Purpose |
|------|---------|
| 19900 | Management web UI |
| 19901 | Azure MCP SSE endpoint (`/sse`) |
| 19902 | Azure DevOps MCP SSE endpoint (`/sse`) |

## Volumes

| Path      | Required? | Purpose |
|-----------|-----------|---------|
| `/config` | yes       | Persists `settings.json` and the `az` CLI session (`/config/azure`) across container restarts |
| `/logs`   | optional  | If mounted and writable, each server's stdout/stderr is written to `<id>.log` (rotated 10 MB × 5) |

## Build

```bash
docker build -t tubesnob-azuremcp .
```

## Run

Host-side config and logs live under `~/.azureMCPContainer` by default so they persist across checkouts of this repo:

```bash
mkdir -p ~/.azureMCPContainer/config ~/.azureMCPContainer/logs
docker run --rm \
  -p 19900:19900 -p 19901:19901 -p 19902:19902 \
  -v "$HOME/.azureMCPContainer/config:/config" \
  -v "$HOME/.azureMCPContainer/logs:/logs" \
  tubesnob-azuremcp
```

Or use compose:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

## First-run walkthrough

1. Open **http://localhost:19900** — the dashboard shows both MCP servers as `Stopped`.
2. Click **Auth** → **Sign in with device code**. The container runs `az login --use-device-code`; the login panel streams the instruction line ("To sign in… enter the code `XXXXXXXX`").
3. Complete sign-in in your browser. The auth page flips to `Signed in as …`.
4. Click the **Azure DevOps MCP** card → **Details**, set your **Organization** (e.g. `contoso`), optionally set the tenant and domains, then **Save**. The server will start and the dashboard will show it as `Running`.
5. The Azure MCP server auto-starts after sign-in by default. Click its card to change configuration (cloud, extra env vars) or view live logs.

## Connecting MCP clients

Point your MCP client (Claude Code, VS Code MCP extension, etc.) at:

- Azure MCP → `http://<host>:19901/sse`
- Azure DevOps MCP → `http://<host>:19902/sse`

These are standard MCP over SSE endpoints exposed by supergateway. The inner stdio servers are spawned and managed by the supervisor.

## Authentication details

The web UI drives a single `az login --use-device-code` flow. After sign-in:

- **Azure MCP** inherits the session via `AZURE_CONFIG_DIR=/config/azure` — `DefaultAzureCredential` picks up `AzureCliCredential`.
- **Azure DevOps MCP** is launched with `-a azcli` (reuses the same session). If your ADO org doesn't support Entra-backed auth, switch the server's **Authentication** setting to **Personal Access Token** and set the PAT.

To sign out, use the **Sign out** button — this runs `az logout`.

## Logging

- **In-memory ring buffer** per server (10,000 lines by default; configurable in Settings). Always available in the server detail page.
- **File logging** to `/logs` when the volume is mounted and writable. One rotating file per server (`azure-mcp.log`, `azure-devops-mcp.log`).

## FAQ

**The dashboard says "Not signed in to Azure" and the servers won't start.**
The supervisor refuses to auto-start the MCP servers until `az login` has succeeded, because both servers need a valid token to do anything useful. Go to the **Auth** page and complete the device-code flow. Once sign-in finishes the configured servers start automatically.

**Logs show "File logging is disabled."**
The container tries to write per-server logs to `/logs`. If that path isn't mounted to a writable host directory, the supervisor falls back to in-memory ring buffers only. Mount a host directory at `/logs` (the example compose file uses `~/.azureMCPContainer/logs`) and restart.

**My `az login` session keeps disappearing.**
That usually means `/config` isn't persisted. The Azure CLI stores its token cache under `AZURE_CONFIG_DIR=/config/azure`, so if `/config` is an anonymous volume or isn't mounted at all, every `docker compose down` wipes the login. Bind-mount a host directory (`~/.azureMCPContainer/config` by convention) to `/config`.

**Port 19900 / 19901 / 19902 is already in use.**
Remap the host side in `docker-compose.yml` (for example `"29900:19900"`). The container always listens on the fixed internal ports; only the host-side mapping needs to change.

**A server shows "crashed" and keeps restarting.**
Open the server detail page from the dashboard to see the tailed log. The most common causes are an expired Azure token (re-run sign-in), a missing Azure DevOps organization URL in Settings, or an upstream `npm` package that failed to resolve because the image was built without network access.

**Azure DevOps MCP rejects auth.**
Confirm `az account show` reports the tenant you expect; otherwise use PAT mode as a fallback.

**Azure MCP not finding a subscription.**
Run `az account set --subscription <id>` from inside the container: `docker exec -it tubesnob-azuremcp az account set --subscription <id>`.

## Attributions

This project stands on the following open-source work:

- [`@azure/mcp`](https://github.com/Azure/azure-mcp) — Microsoft Azure MCP server (MIT)
- [`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp) — Microsoft Azure DevOps MCP server (MIT)
- [`supergateway`](https://github.com/supercorp-ai/supergateway) — stdio ↔ SSE MCP bridge (MIT)
- [Azure CLI](https://github.com/Azure/azure-cli) — official `az` command-line tool (MIT)
- [Node.js](https://nodejs.org) runtime (MIT)
- [Fastify](https://fastify.dev) + `@fastify/view`, `@fastify/static`, `@fastify/formbody` (MIT)
- [Nunjucks](https://mozilla.github.io/nunjucks/) templating (BSD-2-Clause)
- [pino](https://getpino.io) structured logging (MIT)
- [pidusage](https://github.com/soyuka/pidusage) process stats (MIT)
- [rotating-file-stream](https://github.com/iccicci/rotating-file-stream) (MIT)
- [htmx](https://htmx.org) HTML-over-the-wire UI (BSD-2-Clause / 0BSD)
- [tini](https://github.com/krallin/tini) PID 1 init (MIT)
- [Debian](https://www.debian.org) base image (various OSS licenses)

## License

This bundle itself is released under the MIT License — see [`LICENSE`](./LICENSE).
