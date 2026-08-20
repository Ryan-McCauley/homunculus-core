# Changelog

All notable changes to Homunculus Core are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Electron: external links are limited to `http`/`https`.** The window-open
  handler passed any URL straight to `shell.openExternal`, which launches the OS
  handler for whatever scheme it is given — `file://` opens a local path in the
  file manager, and a registered custom scheme starts another application with
  an argument the page chose. The renderer displays agent- and feed-authored
  text, so a link is now checked before it is acted on.
- **Refused HTTP requests carry the defensive headers too.** The 401/503 from
  the token and admin gates were the only responses served without `nosniff`,
  `frame-ancestors` or a CSP — precisely the responses reached by callers who
  should not be there. They also now send `vary: origin`, matching the success
  path, so a cache cannot hand one origin's copy to another.
- **Static serving: percent-decoding, NUL rejection, and a resolved web root.**
  Paths are decoded before resolution (so an asset with a space in its name is
  found rather than falling through to the SPA index), a NUL is refused outright
  rather than silently truncating a path at the syscall boundary, and
  `HOMUNCULUS_WEB_DIR` is resolved once at startup — an override with a trailing
  separator previously failed its own containment check and refused the whole UI.
- **A connection may hold at most four PTYs.** `term:start` is driven by a
  client-chosen id with no ceiling, so one authorised socket could fork shells
  until the host ran out of process table.

### Changed

- **HOME device tiles are configurable per install.** The thermostat, appliance,
  litter-robot, pets and ambient tiles used to name entity ids as literals
  (`climate.thermostat`, `vacuum.r2peepoo_litter_box`, a five-name `CATS`
  array), so they rendered on exactly one house and were blank on every other.
  Tiles now render against named slots bound to whatever entities an install
  actually has, stored in `data/home-tiles.json`. Thresholds and vocabulary —
  the waste-drawer percentages, the cycle phase names, the status codes meaning
  "a pet is inside" — are per-tile options too.
- **Devices are discovered, not declared.** On a fresh data dir the server scans
  Home Assistant once, on the first connected snapshot, and builds a tile per
  recognised device. Correct or extend it from the HOME tab's TILES editor or
  the first-run wizard's DEVICES step; re-scan to pick up devices added later.
  Discovery never re-runs on its own, so a corrected binding stays corrected.
- `snapshot.devices` groups entities by their shared id stem instead of by a
  hardcoded table of one household's device names.
- `event` joins the relevant-domain set, so appliance "cycle done" entities
  reach the UI for the first time.
- **Node 22 LTS across the board.** `.nvmrc` already said 22 and the toolchain
  (Electron 41, `@electron/rebuild` 4) requires ≥22.12, while the README, the
  docs and the Dockerfile still said 20. `package.json` now declares `engines`
  so the package manager says so at install time.
- **`server/staticFiles.ts` and `server/orderMath.ts`** split the static-file
  and order-precision decisions out of `server/index.ts` and `server/crypto.ts`,
  following the precedent set by `server/httpGates.ts`. Both were previously
  untestable — one inside a module that starts a listening server on import, the
  other wrapped around a network fetch — and both are now covered directly.

### Fixed

- **An order retry could ask for more than the caller authorised.** When Gemini
  rejected an amount with `InvalidQuantity`, the self-healing retry reformatted
  it with `toFixed`, which *rounds*: a 0.96 bag retried at zero decimals became
  an order for 1 — more than is held on a sell, and past every notional cap on a
  buy. Amounts now floor, which is the invariant the surrounding code always
  claimed. See `server/orderMath.ts`.
- **Order precision no longer loses a tick to binary floating point.**
  `Math.floor(1.15 * 100) / 100` is 1.14; conforming an amount to a symbol's
  tick size now scales through the decimal exponent instead of multiplying.
- **A coarse quote increment no longer throws from the order path.**
  `floorToTickSize` computed a negative decimal width for an increment above 1,
  and `toFixed(-1)` is a `RangeError`.
- **OSINT feeds are time-bounded.** Node's `fetch` has no default timeout, so a
  third-party feed that accepted a connection and never answered left a promise
  pending forever while the interval fired another request each cycle — and
  stranded the REFRESH button, whose `Promise.allSettled` could never settle.
  Pollers additionally skip a round rather than stacking when one is still in
  flight.
- **Dead WebSocket clients are reaped.** A client that vanished without a close
  frame (a sleeping phone, a laptop leaving the tailnet) held a chat session,
  its PTYs and four hub subscriptions until the OS gave up on the TCP
  connection. A 30s ping/pong heartbeat drops them.
- **`/api/audit?action=` answers the same query the same way from either
  backend.** An unescaped `%` or `_` was a wildcard to Postgres and a literal to
  the file scan.
- The litter tile's night-light button called the *reset* button entity —
  the label said one thing and the click did another. It now cycles the
  night-light select, and is hidden when nothing is bound to it.
- Appliance tiles no longer show the washer's cycle count on the dryer, and no
  longer borrow a sibling appliance's controls when the device lacks its own.
- The thermostat's +/- buttons round to the configured step instead of to whole
  degrees, which previously made a sub-degree step a no-op.

## [1.0.0] — 2026-08-13

First public release of **Homunculus Core** — the shareable edition of the
Homunculus bridge.

### Included

- **BRIDGE** — system vitals, the Computer Core chat (Claude Agent SDK on your
  subscription), a real PTY terminal, and Home Assistant tiles on a draggable
  12-column widget grid.
- **OSINT** — open-source situational watchers with a 3D globe, geofences and
  escalation into the archive.
- **HOME** — Home Assistant dashboard, device grouping and routines.
- **DATA** — dataset browsing and inspection.
- **ARCHIVE** — the persistent event spool: proactive alerts, OSINT escalations
  and geofence breaches, with optional Postgres capture.
- **CRYPTO** — market view, screeners, strategy runner and audit log.

Every panel is a widget: rearrange, resize or move it to another tab from
SETTINGS → WIDGETS, and the layout persists server-side so the desktop shell and
the browser view agree.

### Architecture

A single Node backend (`server/`) does all the work and serves a thin React UI
(`src/`) over HTTP + WebSocket. The Electron shell (`electron/`) is a desktop
window onto the same UI. The backend containerises — see `Dockerfile` and
`docker-compose.yml`.

### Notes

- Requires Node 20 LTS (`.nvmrc`) and a Claude subscription token for the
  Computer Core — see the README.
- Set `HOMUNCULUS_TOKEN` before exposing the backend beyond localhost.
