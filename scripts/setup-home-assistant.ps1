# Home Assistant setup wizard for Homunculus (Windows).
#
# Stands up a Home Assistant instance on this machine — or attaches to one you
# already run — then wires Homunculus to it: prompts for a long-lived access
# token, probes the REST API the same way server/homeassistant.ts does, and
# writes HA_URL / HA_TOKEN into the repo's .env.
#
# The Linux/macOS/Pi equivalent is scripts/setup-home-assistant.sh.
#
#   .\scripts\setup-home-assistant.ps1                       # interactive wizard
#   .\scripts\setup-home-assistant.ps1 -Mode docker -Port 8123
#   .\scripts\setup-home-assistant.ps1 -Mode attach -Url http://ha.local:8123
#
# Nothing here is destructive: an existing container is reused, an existing .env
# is edited in place (with a .bak), and the token is never echoed or logged.

param(
    # docker: run HA Container under Docker Desktop.  vm: point at a HA OS VM or
    # Raspberry Pi you flashed yourself.  attach: HA already runs elsewhere.
    [ValidateSet('docker', 'vm', 'attach')]
    [string]$Mode,
    [int]$Port = 8123,
    [string]$Url,
    [string]$ConfigDir = "$env:USERPROFILE\homeassistant-config",
    # Non-interactive: requires -Mode and the HA_TOKEN environment variable.
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$root      = Split-Path -Parent $PSScriptRoot
$envFile   = Join-Path $root '.env'
$container = 'homeassistant'

function Write-Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor White }
function Write-Ok($m)   { Write-Host "  ok   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host " warn  $m" -ForegroundColor Yellow }
function Fail($m)       { Write-Host " fail  $m" -ForegroundColor Red; exit 1 }

function Ask($prompt, $default) {
    if ($NonInteractive) { return $default }
    $suffix = if ($default) { " [$default]" } else { "" }
    $reply = Read-Host "  $prompt$suffix"
    if ([string]::IsNullOrWhiteSpace($reply)) { return $default }
    return $reply
}

# ── 0. environment detection ──────────────────────────────────────────────────
Write-Step "Detecting environment"

$dockerVersion = $null
if (Get-Command docker -ErrorAction SilentlyContinue) {
    try { $dockerVersion = (docker --version) } catch { $dockerVersion = $null }
}
Write-Host "  os:     $([System.Environment]::OSVersion.VersionString)"
Write-Host "  docker: $(if ($dockerVersion) { $dockerVersion } else { 'not installed' })"

if (-not $Mode) {
    if ($NonInteractive) { Fail "-Mode is required with -NonInteractive" }
    Write-Host ""
    Write-Host "  How should Home Assistant be set up?"
    Write-Host "    1) docker   run Home Assistant Container under Docker Desktop"
    Write-Host "    2) vm       a HA OS VM or Raspberry Pi you flashed yourself"
    Write-Host "    3) attach   Home Assistant already runs on another machine"
    $choice = Ask 'Choice' '1'
    switch ($choice) {
        '1'     { $Mode = 'docker' }
        '2'     { $Mode = 'vm' }
        '3'     { $Mode = 'attach' }
        default { Fail "invalid choice" }
    }
}
Write-Ok "mode: $Mode"

# ── 1. install / locate Home Assistant ────────────────────────────────────────
switch ($Mode) {

    'docker' {
        Write-Step "Home Assistant Container (Docker Desktop)"

        if (-not $dockerVersion) {
            Fail @"
Docker Desktop is not installed. Get it from https://docs.docker.com/desktop/install/windows-install/
then re-run this script. (Or choose mode 'vm' — a HA OS VM gets you supervisor
add-ons and working device discovery, which Docker Desktop cannot provide.)
"@
        }
        docker info | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Fail "Docker is installed but the daemon is not reachable. Start Docker Desktop and re-run."
        }

        # Docker Desktop runs containers inside a WSL2 VM with a NAT'd network, so
        # --network=host is not available. mDNS/SSDP broadcasts from the LAN never
        # reach the container: HA will run fine but will not auto-discover devices.
        Write-Warn "Docker Desktop cannot use host networking — HA will not auto-discover LAN devices."
        Write-Warn "Integrations added by IP/cloud still work. For full discovery, use mode 'vm'."

        # Native command output already arrives as one array element per line.
        $names = @(docker ps -a --format '{{.Names}}')
        $existing = $names | Where-Object { $_.Trim() -eq $container }
        if ($existing) {
            Write-Ok "container '$container' already exists — reusing it"
            docker start $container 2>&1 | Out-Null
        } else {
            New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
            Write-Host "  config volume: $ConfigDir"
            Write-Host "  pulling ghcr.io/home-assistant/home-assistant:stable ..."
            docker pull ghcr.io/home-assistant/home-assistant:stable | Out-Null

            $tz = (Get-TimeZone).Id
            docker run -d `
                --name $container `
                --restart=unless-stopped `
                -e "TZ=$tz" `
                -v "${ConfigDir}:/config" `
                -p "${Port}:8123" `
                ghcr.io/home-assistant/home-assistant:stable | Out-Null
            Write-Ok "container started"
        }

        if (-not $Url) { $Url = "http://127.0.0.1:$Port" }
    }

    'vm' {
        Write-Step "Home Assistant OS (VM or Raspberry Pi)"
        Write-Host @"

  This mode does not install anything — flash HA OS yourself first:
    1. Download Home Assistant OS for your target (Raspberry Pi image, or the
       .vhdx/.ova for Hyper-V / VirtualBox) from home-assistant.io/installation.
    2. Boot it and let onboarding finish. It usually lands on
       http://homeassistant.local:8123.

"@
        if (-not $Url) { $Url = Ask 'Home Assistant base URL' 'http://homeassistant.local:8123' }
    }

    'attach' {
        Write-Step "Attaching to an existing Home Assistant"
        if (-not $Url) {
            if ($NonInteractive) { Fail "-Url is required in attach mode" }
            $Url = Ask 'Home Assistant base URL' 'http://homeassistant.local:8123'
        }
    }
}

$Url = $Url.TrimEnd('/')
Write-Host "  base URL: $Url"

# ── 2. wait for the API to answer ─────────────────────────────────────────────
Write-Step "Waiting for Home Assistant to respond"

# /api/ requires auth, so 401 means "up but unauthenticated" — a perfectly good
# liveness signal, and the one we can get before a token exists.
$deadline = (Get-Date).AddMinutes(5)
$up = $false
while ((Get-Date) -lt $deadline -and -not $up) {
    try {
        # PowerShell 5.1 has no -SkipHttpErrorCheck and rejects the unknown
        # parameter outright, so only pass it where it exists (7+).
        $req = @{ Uri = "$Url/api/"; TimeoutSec = 5; UseBasicParsing = $true }
        if ($PSVersionTable.PSVersion.Major -ge 7) { $req['SkipHttpErrorCheck'] = $true }
        $r = Invoke-WebRequest @req
        if ($r.StatusCode -in 200, 401, 403) { $up = $true; break }
    } catch {
        # On 5.1 a 401 arrives as an exception carrying the response — still a
        # perfectly good liveness signal.
        $resp = $_.Exception.Response
        if ($resp -and $resp.StatusCode.value__ -in 200, 401, 403) { $up = $true; break }
    }
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 3
}
Write-Host ""
if (-not $up) {
    Fail @"
No response from $Url after 5 minutes.
If this is a first-time container start, HA can take a few minutes to build its
initial config — check 'docker logs -f $container' and re-run.
"@
}
Write-Ok "Home Assistant is answering at $Url"

# ── 3. long-lived access token ────────────────────────────────────────────────
Write-Step "Long-lived access token"

$token = $env:HA_TOKEN
if (-not $token) {
    if ($NonInteractive) { Fail "set HA_TOKEN in the environment when using -NonInteractive" }
    Write-Host @"

  Homunculus authenticates with a long-lived access token. Create one yourself —
  this script never handles your password:

    1. Open  $Url  and finish onboarding if you haven't (create your account).
    2. Click your user name (bottom-left) -> Security tab.
    3. Scroll to "Long-lived access tokens" -> Create token.
    4. Name it "Homunculus" and copy the value — HA shows it exactly once.

"@
    # AsSecureString keeps the token off the screen and out of console history.
    $secure = Read-Host "  Paste the token (input hidden)" -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $token) { Fail "no token provided" }

# ── 4. verify the token against the endpoints Homunculus actually uses ────────
Write-Step "Verifying token"

$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

try {
    $cfg = Invoke-RestMethod -Uri "$Url/api/config" -Headers $headers -TimeoutSec 10
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 401) {
        Fail "token rejected (401). Make sure you pasted a long-lived access token, not the URL or a webhook id."
    }
    Fail "could not read $Url/api/config: $($_.Exception.Message)"
}
Write-Ok "authenticated to $($cfg.location_name) (version $($cfg.version), units $($cfg.unit_system.temperature))"

try {
    $states  = Invoke-RestMethod -Uri "$Url/api/states" -Headers $headers -TimeoutSec 15
    $climate = @($states | Where-Object { $_.entity_id -like 'climate.*' })
    Write-Ok "$($states.Count) entities visible ($($climate.Count) climate — the thermostat panels need at least one)"
    if ($climate.Count -eq 0) {
        Write-Warn "no climate entities yet; THERMOSTAT will render empty until one exists."
    }
} catch {
    Write-Warn "/api/states failed ($($_.Exception.Message)) — the panels may come up empty."
}

# ── 5. write .env ─────────────────────────────────────────────────────────────
Write-Step "Wiring Homunculus"

if (-not (Test-Path $envFile)) {
    $example = Join-Path $root '.env.example'
    if (Test-Path $example) {
        Copy-Item $example $envFile
        Write-Ok "created .env from .env.example"
    } else {
        New-Item -ItemType File -Path $envFile | Out-Null
        Write-Ok "created empty .env"
    }
}

Copy-Item $envFile "$envFile.bak" -Force

# Read as an array of lines so the rewrite preserves everything else verbatim.
$lines = @(Get-Content $envFile)
function Set-EnvKey([string[]]$lines, [string]$key, [string]$value) {
    $pattern = "^\s*#?\s*$([regex]::Escape($key))="
    $found = $false
    $out = foreach ($line in $lines) {
        if (-not $found -and $line -match $pattern) { $found = $true; "$key=$value" }
        else { $line }
    }
    if (-not $found) { $out = @($out) + "$key=$value" }
    return @($out)
}
$lines = Set-EnvKey $lines 'HA_URL'   $Url
$lines = Set-EnvKey $lines 'HA_TOKEN' $token
Set-Content -Path $envFile -Value $lines -Encoding utf8
Write-Ok "HA_URL and HA_TOKEN written to .env (previous copy: .env.bak)"
Write-Warn ".env and .env.bak now hold a credential — keep them out of git (they are gitignored) and off shared drives."

Write-Step "Done"
Write-Host @"

  Home Assistant : $Url
  Homunculus env : $envFile

  Restart Homunculus to pick up the new config:
     docker compose up -d --build        # container
     npm run start                       # local

  Then open the HOME / THERMOSTAT panels. If they stay empty, check the server
  logs: server/homeassistant.ts holds the last good snapshot for 3 failed polls
  before reporting the house offline.

"@
