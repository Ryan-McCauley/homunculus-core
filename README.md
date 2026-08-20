# Homunculus Core

A starship-bridge command interface for your home, computers, and data — powered by Claude.

### → [See the walkthrough at www.ryanmccauley.com/homunculus](https://www.ryanmccauley.com/homunculus)

Annotated screen captures of every surface — the six tabs, the ⌘K uplink, the agent
fleet, the architecture and the security model, panel by panel. The fastest way to
tell whether this is worth standing up on your own hardware.

Inspirations: the Star Trek Enterprise computer, Iron Man's Jarvis, a Bond-villain
control room, and the eDEX-UI terminal aesthetic.

Also on the walkthrough site:
[the CRYPTO desk in detail](https://www.ryanmccauley.com/homunculus/crypto) ·
[full documentation](https://www.ryanmccauley.com/homunculus/docs/)
(the same pages live in [`docs/`](docs/) here).

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

**Requirements:** Node 22 LTS (`nvm use` — see `.nvmrc`). No Xcode/native-build dance
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
Compose reads `.env`, so create one first — without it `docker compose` aborts with
"env file not found":
```bash
cp .env.example .env    # then fill in CLAUDE_CODE_OAUTH_TOKEN and HOMUNCULUS_TOKEN
docker compose up --build
```
The container publishes to `127.0.0.1:8787` only. To reach it from your phone, put
it on the tailnet deliberately (`tailscale serve`, or bind the tailnet IP in
`docker-compose.yml`) **and** set `HOMUNCULUS_TOKEN` — remote requests without one
are refused.

By default telemetry/terminal reflect the **container**. To monitor/shell the host,
see the commented host-scope options in `docker-compose.yml`.

## Desktop app (packaged)

> **The desktop app is a client, not the whole thing.** It is a window onto the
> backend — it does not contain or start one. Install the app *and* run a
> backend, or you will get a "no backend" screen instead of the bridge.

Build installers from source with `npm run dist` (or `npm run dist:mac`); they
land in `dist/`. Targets are dmg (macOS), NSIS (Windows) and AppImage (Linux).

Then:

1. **Start a backend** — `npm run start` from a checkout, or `docker compose up`.
2. **Launch the app.** It looks for `http://localhost:8787`. If nothing is
   there it shows a waiting screen and keeps retrying, connecting by itself as
   soon as the backend is up.

To point the app at a backend on another machine, set `HOMUNCULUS_URL`:

```bash
HOMUNCULUS_URL=http://your-host:8787 open -a Homunculus
```

Note that the OS-keychain vault is deliberately disabled against a remote
backend — pushing keys to another host would put them on the wire — so enter
credentials on the machine running the backend.

### macOS: "Homunculus is damaged" / "unidentified developer"

Builds from this repo are **not notarized**, so Gatekeeper blocks them after a
download. That warning is about the absent Apple signature, not the contents.
Clear the quarantine flag after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Homunculus.app
```

To produce notarized builds yourself you need a paid Apple Developer account and
a **Developer ID Application** certificate (an "Apple Development" certificate
is not enough — it only covers your own registered machines). With one
installed, export the three variables below and build with `NOTARIZE=1`:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # appleid.apple.com
export APPLE_TEAM_ID="XXXXXXXXXX"
NOTARIZE=1 npm run dist:mac
```

Hardened runtime and entitlements (`build/entitlements.mac.plist`) are already
configured; `NOTARIZE=1` is what turns on the signing-and-stapling step.

## Home Assistant

The HOME tab and the BRIDGE Home Assistant tiles poll a Home Assistant instance
over its REST API (`server/homeassistant.ts`). Two things are needed: `HA_URL`
and a long-lived access token in `HA_TOKEN`.

A wizard handles both — standing HA up on a new machine if it isn't running yet,
then verifying the token and writing the two keys into `.env`:

```bash
./scripts/setup-home-assistant.sh
```

```powershell
.\scripts\setup-home-assistant.ps1
```

It asks how HA should be set up and branches accordingly:

| Mode | What it does |
| --- | --- |
| `docker` | Runs Home Assistant Container here. On Linux it uses host networking so mDNS/SSDP device discovery works; Docker Desktop on Windows/macOS can't, so discovery is limited to IP/cloud integrations. |
| `supervised` / `vm` | HA OS or Supervised is already on this machine (or a Pi/VM you flashed) — skips install, wires up only. |
| `attach` | HA runs elsewhere; just point at its URL. |

The script never handles your HA password — it prints the steps to mint a
long-lived token in the HA UI, reads it with echo off, then probes `/api/config`
and `/api/states` before writing anything. Both flags and env vars are accepted
for unattended runs:

```bash
HA_TOKEN=... ./scripts/setup-home-assistant.sh --mode attach --url http://ha.local:8123 --non-interactive
```

Restart Homunculus afterwards to pick up the new config.

## Layout

```
server/        Node backend: index.ts (HTTP+WS), telemetry, chat, terminal
shared/        types shared by server and clients (protocol.ts, api.ts, …)
src/           React web UI: App.tsx, panels/, components/, transport.ts
electron/      thin desktop shell (main.ts only)
Dockerfile     backend image
```

## License and dependencies

Homunculus Core is MIT licensed — see [LICENSE](LICENSE). Use it, fork it, ship
it; just keep the copyright notice.

**One dependency is not open source.** The Computer Core and every agent session
run on `@anthropic-ai/claude-agent-sdk`, which is proprietary software owned by
Anthropic PBC ("all rights reserved", governed by [Anthropic's legal
terms](https://code.claude.com/docs/en/legal-and-compliance)). It is installed
from npm like any other package, and running it needs your own Claude Pro/Max
subscription token — see [Computer Core auth](#computer-core-auth-subscription-not-the-api)
above. Nothing in this repository redistributes it.

Everything else in the tree is permissively licensed (MIT, ISC, BSD-2-Clause,
Unlicense). Per-package attributions are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

> If you package a desktop build with `npm run dist`, note that
> `electron-builder` bundles `node_modules` into the artifact — which embeds the
> Agent SDK. Publishing source is unaffected; distributing binaries is worth
> checking against Anthropic's terms first.
