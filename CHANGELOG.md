# Changelog

All notable changes to Homunculus Core are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
