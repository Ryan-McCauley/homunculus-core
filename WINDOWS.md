# Running Homunculus on Windows (Docker) + Phone/Watch/Browser access

Homunculus is a standalone Node backend that serves the web UI and multiplexes
everything (telemetry, Computer Core chat, terminal, crypto, OSINT)
over one WebSocket. Any device with a browser is a client — so "run it on the
Windows desktop and reach it from my phone/watch/browser" is a deployment task,
not a rewrite.

This guide runs the backend in **Docker Desktop (WSL2)** on Windows and exposes
it privately over **Tailscale**.

> **What Docker changes:** the **System Vitals** panel and the **embedded
> terminal** reflect the *container* (a small Linux VM), not your Windows host.
> Everything else — Computer Core, Crypto, OSINT, Home Assistant —
> works fully. If host-level CPU/GPU/process telemetry is important to you, tell
> me and we'll do a native-Windows-Node setup instead.

---

## 1. Prerequisites (install on the Windows desktop)

1. **Docker Desktop** with the WSL2 backend — <https://www.docker.com/products/docker-desktop/>
   During install, keep "Use WSL 2 instead of Hyper-V" checked. Reboot when asked.
2. **Git for Windows** — <https://git-scm.com/download/win>
3. **Tailscale** — <https://tailscale.com/download/windows>. Sign in with the
   same account you'll use on your phone/laptop.
4. **The `claude` CLI** (only needed *once*, to mint a subscription token — see §3).
   Install per Anthropic's instructions, then `claude` and log in with your Pro/Max account.

---

## 2. Get the code

```powershell
git clone <your-homunculus-remote> Homunculus
cd Homunculus
Copy-Item .env.example .env
```

---

## 3. Fill in `.env`

Open `.env` in an editor. The two that matter most:

- **`CLAUDE_CODE_OAUTH_TOKEN`** — powers the Computer Core using your Claude
  subscription (no API billing). Generate it:
  ```powershell
  claude setup-token
  ```
  Copy the printed token into `.env`. (You can generate it on any machine where
  `claude` is logged in — it's just a string.)

- **`HOMUNCULUS_TOKEN`** — **set this before exposing anything over Tailscale.**
  It gates the WebSocket and the crypto REST routes for every non-localhost
  caller. Generate a strong one:
  ```powershell
  .\scripts\homunculus.ps1 token
  ```
  Paste the output line into `.env`.

Optional keys (`GEMINI_*` for the Crypto tab, `HA_*` for Home Assistant,
`OSINT_*`, `DATABASE_URL` for history) are documented inline in `.env.example`.

---

## 4. Start it

```powershell
.\scripts\homunculus.ps1 up
```

This builds the image and starts the container in the background, then prints
your local and Tailscale URLs. Verify locally first:

- Open <http://localhost:8787> in the Windows browser.
- Health check: <http://localhost:8787/healthz> should say `ok`.

Useful commands:

| Command | Does |
|---|---|
| `.\scripts\homunculus.ps1 logs` | Tail the backend logs |
| `.\scripts\homunculus.ps1 status` | Show container status |
| `.\scripts\homunculus.ps1 down` | Stop |
| `.\scripts\homunculus.ps1 rebuild` | Rebuild after `git pull` and restart |
| `.\scripts\homunculus.ps1 url` | Print the phone/watch URL |

---

## 5. Reach it from your phone, watch, and other browsers (Tailscale)

1. Install Tailscale on the phone/laptop and sign into the **same** account.
2. On the Windows PC, get the URL:
   ```powershell
   .\scripts\homunculus.ps1 url
   ```
   It prints something like `http://your-pc.tailnet-name.ts.net:8787?token=...`.
3. Open that URL on the phone/laptop browser. The `?token=` is required off the
   home PC — bookmark the full URL so you don't retype it.

Notes:
- **No port-forwarding, no public exposure.** Tailscale is a private mesh; only
  your own devices can reach the PC *over the tailnet*. Note this is about the
  internet, not your LAN: if you change the compose port mapping from the default
  `127.0.0.1:8787:8787` to a bare `8787:8787`, the port is published on every
  interface and anything on your home Wi-Fi can reach it. Set `HOMUNCULUS_TOKEN`
  before you do that — without one the server refuses remote requests outright,
  which is the safe failure but also a broken phone view.
- **Apple Watch** has no general browser. Realistic options: a phone-side
  shortcut/complication that opens the URL, or a later dedicated watch surface.
  Tell me what you want the watch to *show* and we'll design for it.
- **Keep the PC awake and Docker running** — this matters for trade safety, not
  just reachability. See [§6 Keep it running 24/7](#6-keep-it-running-247-required-for-take-profit-orders).

---

## 6. Keep it running 24/7 (required for take-profit orders)

**Why this is not optional if you trade.** Gemini has no native bracket/OCO order.
The Homunculus engine works around that with a *software* OCO: the **stop-loss is a
real resting order on Gemini** (it fires even if this PC is off), but the
**take-profit is enforced by the backend's monitor loop**, which polls price every
~20s and places the exit when your target is hit. That loop only runs while this PC
is awake and the container is up. **If the machine sleeps or Docker stops, your
take-profits stop being watched — only the stop-loss can still fire.** A price spike
through your target then round-trips to the stop instead of banking the gain.

One command sets everything below (never-sleep, never-hibernate, lid-close = do
nothing, Docker Desktop auto-start on login) and verifies the container is up:

```powershell
.\scripts\homunculus.ps1 uptime
```

What it configures (all reversible; run from an elevated PowerShell for the power
settings to stick):

- **Never sleep / hibernate on AC** — `powercfg /change standby-timeout-ac 0` and
  `hibernate-timeout-ac 0`. (The screen may still turn off; that's fine — it doesn't
  pause WSL or the container.)
- **Lid-close does nothing** (laptops) so shutting the lid doesn't suspend the box.
- **Docker Desktop auto-starts on login** via a Startup-folder shortcut — because
  `restart: unless-stopped` in `docker-compose.yml` only revives the container when
  the Docker daemon is already running.

**One gap it can't close by itself:** after a full reboot, Docker Desktop only
launches once you **sign in**. For unattended restarts (e.g. a power blip while
you're away), also enable **Windows auto-login** for this user so the session — and
Docker with it — comes back on its own.

Sanity-check anytime with `.\scripts\homunculus.ps1 status` (the `homunculus`
container should read `Up`).

---

## 7. Data persistence & backup

All state (crypto trades/plans, OSINT cache, archive spool)
lives in Docker named volumes, so `rebuild` / `git pull` won't wipe it:

- `homunculus-data`  → `/app/data`
- `homunculus-private` → `/app/private`
- `homunculus-pg` → Postgres data (only if you enable history)

Back up the important one:
```powershell
docker run --rm -v homunculus-data:/data -v ${PWD}:/backup alpine `
  tar czf /backup/homunculus-data-backup.tgz -C /data .
```

---

## 8. Optional: enable the Data + Archive tabs (Postgres)

```powershell
# set DATABASE_URL in .env to the bundled DB, then:
.\scripts\homunculus.ps1 up -History
```
Set both in `.env` — compose will not start the database without a password, and
there is no default:
```
POSTGRES_PASSWORD=choose-something-long
DATABASE_URL=postgres://homunculus:choose-something-long@db:5432/homunculus
```

---

## 9. Updating

```powershell
git pull
.\scripts\homunculus.ps1 rebuild
```

---

## Troubleshooting

- **Computer Core says 401 / invalid credentials** — `CLAUDE_CODE_OAUTH_TOKEN`
  is missing/expired. Re-run `claude setup-token` and `rebuild`.
- **Phone can't connect** — confirm both devices show as connected in Tailscale,
  and that you included `?token=` in the URL.
- **Vitals/terminal look like Linux, not Windows** — expected under Docker (see
  the note at the top). Ask for the native-Node setup if you need host metrics.
- **Data disappeared after a rebuild** — you're likely on an old `docker-compose.yml`
  without the `volumes:` block; pull the latest.
