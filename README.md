# Homunculus Core

A starship-bridge command interface for your home, computers, and data — powered by Claude.

Inspirations: the Star Trek Enterprise computer, Iron Man's Jarvis, a Bond-villain
control room, and the eDEX-UI terminal aesthetic.

## Tabs

Six built-in tabs, each a grid of widgets you can rearrange, resize, or move to
another tab from SETTINGS → WIDGETS. The layout persists server-side, so the
desktop shell and the browser view always agree.

| Tab | What it is |
| --- | --- |
| **BRIDGE** | System vitals, the Computer Core chat, a real terminal, and Home Assistant tiles |
| **OSINT** | Open-source situational watchers on a 3D globe, with geofences and escalations |
| **HOME** | Home Assistant dashboard — devices, grouping, routines |
| **DATA** | Dataset browsing and inspection |
| **ARCHIVE** | The persistent event spool, with optional Postgres capture |
| **CRYPTO** | Market view, screeners, strategy runner, audit log |

## Architecture

**Hybrid client–server.** A standalone Node backend does all the work; clients are
thin.

```
┌─ Backend (Node — containerizable) ─────────────────┐
│  HTTP (serves the web UI)  +  WebSocket API        │
│  ├─ telemetry (systeminformation)                  │
│  ├─ Computer Core (Claude Agent SDK, local session)│
│  └─ terminal (node-pty, coalesced output)          │
└───────────────┬────────────────────────────────────┘
                │ WebSocket (over Tailscale for remote)
        ┌───────┴────────┐
   Browser / iPhone   Electron desktop shell
   (the bridge UI; same code, transport-agnostic)
```

- **Backend** (`server/`) — one Node process, runs in Docker. The Computer Core runs
  here in plain Node (not Electron's main process, which crashed).
- **Web UI** (`src/`) — the React bridge, served by the backend and reachable from any
  browser. Talks to the backend via WebSocket (`src/transport.ts`), exposed to the
  panels as `window.homunculus`.
- **Electron shell** (`electron/`) — a thin desktop window that loads the same web UI
  and connects as a client. No heavy logic.

## Computer Core auth (subscription, not the API)

The Computer Core runs on your **Claude subscription** via the Agent SDK — no
per-token API billing. It needs a long-lived subscription token:

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have the CLI
claude setup-token                          # prints sk-ant-oat01-...
```

Put it where the **backend** reads it — `.env` for local dev, or the container env:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# HOMUNCULUS_MODEL=sonnet        # optional model override
# HOMUNCULUS_TOKEN=...           # gate the WebSocket when reachable beyond localhost
```

## Run it

**Requirements:** Node 20 LTS (`nvm use` — see `.nvmrc`). No Xcode/native-build dance
needed anymore: `node-pty` runs under Node with prebuilt binaries.

### Desktop (Electron + backend, hot reload)
```bash
npm install
npm run dev      # runs the backend (:8787) and the Electron shell together
```

### Browser
- **Dev:** with `npm run dev` running, open <http://localhost:5173>.
- **Prod:** `npm run build:web && npm run start`, then open <http://localhost:8787>.

### iPhone / remote (over Tailscale)
Set `HOMUNCULUS_TOKEN`, run the backend, then browse to
`http://<tailscale-ip>:8787/?token=<HOMUNCULUS_TOKEN>` from your phone.

### Docker
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... HOMUNCULUS_TOKEN=yoursecret \
  docker compose up --build
```
By default telemetry/terminal reflect the **container**. To monitor/shell the host,
see the commented host-scope options in `docker-compose.yml`.

## Layout

```
server/        Node backend: index.ts (HTTP+WS), telemetry, chat, terminal
shared/        types shared by server and clients (protocol.ts, api.ts, …)
src/           React web UI: App.tsx, panels/, components/, transport.ts
electron/      thin desktop shell (main.ts only)
Dockerfile     backend image
```

## License

MIT — see [LICENSE](LICENSE).
