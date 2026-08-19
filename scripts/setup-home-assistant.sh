#!/usr/bin/env bash
# Home Assistant setup wizard for Homunculus (Linux / macOS / Raspberry Pi).
#
# Stands up a Home Assistant instance on this machine — or attaches to one you
# already run — then wires Homunculus to it: prompts for a long-lived access
# token, probes the REST API the same way server/homeassistant.ts does, and
# writes HA_URL / HA_TOKEN into the repo's .env.
#
# The Windows equivalent is scripts/setup-home-assistant.ps1.
#
#   ./scripts/setup-home-assistant.sh              # interactive wizard
#   ./scripts/setup-home-assistant.sh --mode docker --port 8123
#   ./scripts/setup-home-assistant.sh --mode attach --url http://ha.local:8123
#   HA_TOKEN=... ./scripts/setup-home-assistant.sh --mode attach --url ... --non-interactive
#
# Nothing here is destructive: an existing container is reused, an existing .env
# is edited in place (with a .bak), and the token is never echoed or logged.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
CONTAINER="homeassistant"

MODE=""
HA_PORT="8123"
URL=""
CONFIG_DIR="${HA_CONFIG_DIR:-$HOME/homeassistant-config}"
INTERACTIVE=1
TOKEN="${HA_TOKEN:-}"

# ── output helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; OFF=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GRN=''; YEL=''; OFF=''
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s warn%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '%s fail%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: setup-home-assistant.sh [options]

  --mode <docker|supervised|attach>  Install method (default: asked interactively)
  --port <n>                         Host port for HA (docker mode, default 8123)
  --url  <url>                       Existing HA base URL (attach mode)
  --config-dir <path>                HA config volume (docker mode,
                                     default ~/homeassistant-config)
  --non-interactive                  Fail instead of prompting; requires
                                     --mode, and HA_TOKEN in the environment
  -h, --help                         This message

Modes:
  docker      Run Home Assistant Container via Docker on this machine.
  supervised  You are on Home Assistant OS / Supervised — skip install, wire up only.
  attach      Home Assistant already runs somewhere else — wire up only.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)            MODE="${2:-}"; shift 2 ;;
    --port)            HA_PORT="${2:-}"; shift 2 ;;
    --url)             URL="${2:-}"; shift 2 ;;
    --config-dir)      CONFIG_DIR="${2:-}"; shift 2 ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage; die "unknown option: $1" ;;
  esac
done

ask() {  # ask <prompt> <default> -> echoes answer
  local prompt="$1" default="${2:-}" reply=""
  if [ "$INTERACTIVE" -eq 0 ]; then printf '%s' "$default"; return; fi
  read -r -p "$prompt${default:+ [$default]}: " reply </dev/tty || true
  printf '%s' "${reply:-$default}"
}

confirm() {  # confirm <prompt>  -> exit 0 on yes
  [ "$INTERACTIVE" -eq 0 ] && return 0
  local reply; read -r -p "$1 [y/N]: " reply </dev/tty || true
  [[ "$reply" =~ ^[Yy] ]]
}

# ── 0. environment detection ──────────────────────────────────────────────────
step "Detecting environment"

OS="$(uname -s)"
ARCH="$(uname -m)"
IS_PI=0
if [ -r /proc/device-tree/model ] && grep -qi raspberry /proc/device-tree/model 2>/dev/null; then IS_PI=1; fi
IS_HAOS=0
if [ -d /usr/share/hassio ] || command -v ha >/dev/null 2>&1; then IS_HAOS=1; fi

say "  platform: $OS/$ARCH$([ "$IS_PI" -eq 1 ] && echo ' (Raspberry Pi)')"
say "  docker:   $(command -v docker >/dev/null 2>&1 && docker --version 2>/dev/null || echo 'not installed')"
[ "$IS_HAOS" -eq 1 ] && say "  detected: Home Assistant OS / Supervised (ha CLI present)"

if [ -z "$MODE" ]; then
  if [ "$IS_HAOS" -eq 1 ]; then
    MODE="supervised"
  elif [ "$INTERACTIVE" -eq 0 ]; then
    die "--mode is required with --non-interactive"
  else
    say ""
    say "  How should Home Assistant be set up?"
    say "    1) docker      run Home Assistant Container here (recommended)"
    say "    2) supervised  this machine already runs HA OS / Supervised"
    say "    3) attach      Home Assistant runs on another machine"
    case "$(ask '  Choice' 1)" in
      1) MODE=docker ;;
      2) MODE=supervised ;;
      3) MODE=attach ;;
      *) die "invalid choice" ;;
    esac
  fi
fi
ok "mode: $MODE"

# ── 1. install / locate Home Assistant ────────────────────────────────────────
case "$MODE" in

docker)
  step "Home Assistant Container"

  command -v docker >/dev/null 2>&1 || die \
    "Docker is not installed. Install it first (https://docs.docker.com/engine/install/), then re-run.
     On Debian/Ubuntu/Pi OS the one-liner is:  curl -fsSL https://get.docker.com | sh"
  docker info >/dev/null 2>&1 || die \
    "Docker is installed but not reachable. Start the daemon (sudo systemctl start docker),
     and if this is a fresh install add yourself to the docker group:
       sudo usermod -aG docker \$USER   # then log out and back in"

  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    ok "container '$CONTAINER' already exists — reusing it"
    docker start "$CONTAINER" >/dev/null 2>&1 || true
  else
    mkdir -p "$CONFIG_DIR"
    say "  config volume: $CONFIG_DIR"

    # Host networking is what makes mDNS/SSDP/HomeKit discovery work, and it is
    # available on Linux only. On macOS Docker runs in a VM, so fall back to a
    # published port and accept that auto-discovery will not find LAN devices.
    NET_ARGS=(--network=host)
    if [ "$OS" != "Linux" ]; then
      warn "host networking is Linux-only — publishing port $HA_PORT instead."
      warn "device auto-discovery (mDNS/SSDP) will not see your LAN from inside Docker."
      NET_ARGS=(-p "$HA_PORT:8123")
    elif [ "$HA_PORT" != "8123" ]; then
      warn "host networking ignores --port; HA will listen on 8123."
      HA_PORT=8123
    fi

    say "  pulling ghcr.io/home-assistant/home-assistant:stable …"
    docker pull ghcr.io/home-assistant/home-assistant:stable >/dev/null

    docker run -d \
      --name "$CONTAINER" \
      --restart=unless-stopped \
      --privileged \
      -e "TZ=$(timedatectl show -p Timezone --value 2>/dev/null || echo UTC)" \
      -v "$CONFIG_DIR:/config" \
      -v /run/dbus:/run/dbus:ro \
      "${NET_ARGS[@]}" \
      ghcr.io/home-assistant/home-assistant:stable >/dev/null
    ok "container started"
  fi

  [ -z "$URL" ] && URL="http://127.0.0.1:$HA_PORT"
  ;;

supervised)
  step "Using the Home Assistant instance on this machine"
  [ -z "$URL" ] && URL="http://127.0.0.1:8123"
  ;;

attach)
  step "Attaching to an existing Home Assistant"
  if [ -z "$URL" ]; then
    [ "$INTERACTIVE" -eq 0 ] && die "--url is required in attach mode"
    URL="$(ask '  Home Assistant base URL' 'http://homeassistant.local:8123')"
  fi
  ;;

*) die "unknown mode: $MODE" ;;
esac

URL="${URL%/}"
say "  base URL: $URL"

# ── 2. wait for the API to answer ─────────────────────────────────────────────
step "Waiting for Home Assistant to respond"

# /api/ requires auth and 401 means "up but unauthenticated" — a perfectly good
# liveness signal, and the one we can get before a token exists.
deadline=$(( $(date +%s) + 300 ))
up=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/api/" 2>/dev/null || echo 000)"
  case "$code" in
    200|401|403) up=1; break ;;
  esac
  printf '.'
  sleep 3
done
printf '\n'
[ "$up" -eq 1 ] || die "no response from $URL after 5 minutes.
     If this is a first-time container start, HA can take a few minutes to build
     its initial config — check 'docker logs -f $CONTAINER' and re-run."
ok "Home Assistant is answering at $URL"

# ── 3. long-lived access token ────────────────────────────────────────────────
step "Long-lived access token"

if [ -z "$TOKEN" ]; then
  if [ "$INTERACTIVE" -eq 0 ]; then
    die "set HA_TOKEN in the environment when using --non-interactive"
  fi
  cat <<EOF

  Homunculus authenticates with a long-lived access token. Create one yourself —
  this script never handles your password:

    1. Open  $URL  and finish onboarding if you haven't (create your account).
    2. Click your user name (bottom-left) → Security tab.
    3. Scroll to "Long-lived access tokens" → Create token.
    4. Name it "Homunculus" and copy the value — HA shows it exactly once.

EOF
  # -s: the token is a credential; keep it off the screen and out of shell history.
  read -r -s -p "  Paste the token (input hidden): " TOKEN </dev/tty || true
  printf '\n'
fi
[ -n "$TOKEN" ] || die "no token provided"

# ── 4. verify the token against the endpoints Homunculus actually uses ────────
step "Verifying token"

api() {  # api <path> -> body on stdout, http code in $HTTP_CODE
  local body
  body="$(curl -s -w '\n%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$URL$1" 2>/dev/null || printf '\n000')"
  HTTP_CODE="${body##*$'\n'}"
  printf '%s' "${body%$'\n'*}"
}

cfg="$(api /api/config)"
case "$HTTP_CODE" in
  200) ;;
  401) die "token rejected (401). Make sure you pasted a long-lived access token, not the URL or a webhook id." ;;
  000) die "could not reach $URL/api/config." ;;
  *)   die "unexpected response from /api/config: HTTP $HTTP_CODE" ;;
esac

# Small enough to read with grep rather than taking on a jq dependency.
loc="$(printf '%s' "$cfg" | grep -o '"location_name":"[^"]*"' | cut -d'"' -f4)"
ver="$(printf '%s' "$cfg" | grep -o '"version":"[^"]*"'       | cut -d'"' -f4)"
unit="$(printf '%s' "$cfg" | grep -o '"temperature":"[^"]*"'  | cut -d'"' -f4)"
ok "authenticated to ${loc:-Home Assistant} (version ${ver:-unknown}, units ${unit:-?})"

states="$(api /api/states)"
if [ "$HTTP_CODE" = "200" ]; then
  n_all="$(printf '%s' "$states" | grep -o '"entity_id":' | wc -l | tr -d ' ')"
  n_climate="$(printf '%s' "$states" | grep -o '"entity_id":"climate\.' | wc -l | tr -d ' ')"
  ok "$n_all entities visible ($n_climate climate — the thermostat panels need at least one)"
  [ "$n_climate" = "0" ] && warn "no climate entities yet; THERMOSTAT will render empty until one exists."
else
  warn "/api/states returned HTTP $HTTP_CODE — the panels may come up empty."
fi

# ── 5. write .env ─────────────────────────────────────────────────────────────
step "Wiring Homunculus"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$ROOT/.env.example" ]; then
    cp "$ROOT/.env.example" "$ENV_FILE"
    ok "created .env from .env.example"
  else
    : > "$ENV_FILE"
    ok "created empty .env"
  fi
fi

set_env() {  # set_env <KEY> <value> — replaces the key in place, or appends it
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" "$ENV_FILE"; then
    # Rewrite via awk so the value is never re-interpreted by the shell or sed.
    awk -v k="$key" -v v="$val" '
      $0 ~ "^[[:space:]]*#?[[:space:]]*" k "=" && !done { print k "=" v; done=1; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    cp "$ENV_FILE" "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

cp "$ENV_FILE" "$ENV_FILE.bak"
set_env HA_URL   "$URL"
set_env HA_TOKEN "$TOKEN"
chmod 600 "$ENV_FILE" 2>/dev/null || true
ok "HA_URL and HA_TOKEN written to .env (previous copy: .env.bak)"

# .env.bak now holds a credential too — same permissions, same care.
chmod 600 "$ENV_FILE.bak" 2>/dev/null || true

step "Done"
cat <<EOF

  Home Assistant : $URL
  Homunculus env : $ENV_FILE

  Restart Homunculus to pick up the new config:
     docker compose up -d --build        # container
     npm run start                       # local

  Then open the HOME / THERMOSTAT panels. If they stay empty, check the server
  logs: server/homeassistant.ts holds the last good snapshot for 3 failed polls
  before reporting the house offline.

EOF
