<#
.SYNOPSIS
  Homunculus control script for Windows (Docker Desktop / WSL2).

.DESCRIPTION
  Wraps `docker compose` for the common lifecycle actions. Run from the repo root
  in PowerShell. See WINDOWS.md for first-time setup.

.EXAMPLE
  .\scripts\homunculus.ps1 up          # build (if needed) and start in the background
  .\scripts\homunculus.ps1 up -History # also start the bundled Postgres (Data/Archive tabs)
  .\scripts\homunculus.ps1 logs        # tail logs
  .\scripts\homunculus.ps1 down        # stop
  .\scripts\homunculus.ps1 rebuild     # rebuild image after a `git pull` and restart
  .\scripts\homunculus.ps1 uptime      # harden this PC to stay up 24/7 (never sleep, Docker autostart)
  .\scripts\homunculus.ps1 token       # generate a random HOMUNCULUS_TOKEN
  .\scripts\homunculus.ps1 url         # print the Tailscale URL to open on your phone
#>

param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'down', 'restart', 'rebuild', 'logs', 'status', 'uptime', 'token', 'url')]
  [string]$Action = 'up',

  [switch]$History   # include the optional Postgres service
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Compose args: add the `history` profile when -History is passed.
$profileArgs = if ($History) { @('--profile', 'history') } else { @() }

function Assert-Env {
  if (-not (Test-Path '.env')) {
    Write-Host "No .env found. Copy .env.example to .env and fill it in first:" -ForegroundColor Yellow
    Write-Host "  Copy-Item .env.example .env" -ForegroundColor Yellow
    exit 1
  }
}

switch ($Action) {
  'up' {
    Assert-Env
    docker compose @profileArgs up -d --build
    Write-Host "`nHomunculus is up. Local:  http://localhost:8787" -ForegroundColor Green
    & $PSCommandPath url
  }
  'down'    { docker compose @profileArgs down }
  'restart' { docker compose @profileArgs restart }
  'rebuild' {
    Assert-Env
    docker compose @profileArgs up -d --build
    Write-Host "Rebuilt and restarted." -ForegroundColor Green
  }
  'logs'    { docker compose logs -f --tail 100 }
  'status'  { docker compose ps }
  'uptime'  {
    # The take-profit side of every managed bracket is enforced by the backend's
    # in-process monitor loop — NOT by Gemini (Gemini has no OCO; only the stop-loss
    # rests on the exchange). If this PC sleeps or Docker isn't running, the TP goes
    # unwatched and only the stop can fire. This hardens the host so that can't happen.
    Write-Host "Hardening this PC to stay up 24/7 (keeps the take-profit monitor alive)..." -ForegroundColor Cyan

    # 1. Never sleep or hibernate while on AC power (0 = Never).
    powercfg /change standby-timeout-ac 0
    powercfg /change hibernate-timeout-ac 0
    Write-Host "  [set] AC sleep + hibernate timeouts -> Never" -ForegroundColor Green

    # 2. Laptops: closing the lid on AC must NOT sleep the machine (0 = do nothing).
    try {
      powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
      powercfg /setactive SCHEME_CURRENT
      Write-Host "  [set] Lid-close on AC -> Do nothing (laptops)" -ForegroundColor Green
    } catch {
      Write-Host "  [skip] Could not set lid action (fine on desktops)." -ForegroundColor Yellow
    }

    # 3. Launch Docker Desktop automatically on sign-in (Startup-folder shortcut).
    #    `restart: unless-stopped` only brings the container back if the Docker daemon
    #    is running — so Docker Desktop itself must start on login.
    $docker = Join-Path $Env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $docker) {
      $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Docker Desktop.lnk'
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut($lnk)
      $sc.TargetPath = $docker
      $sc.Save()
      Write-Host "  [set] Docker Desktop auto-starts on login -> $lnk" -ForegroundColor Green
    } else {
      Write-Host "  [skip] Docker Desktop.exe not at the default path. Enable it manually:" -ForegroundColor Yellow
      Write-Host "         Docker Desktop -> Settings -> General -> 'Start Docker Desktop when you sign in'." -ForegroundColor Yellow
    }

    # 4. Make sure the stack is actually running right now.
    Assert-Env
    docker compose @profileArgs up -d
    Write-Host "`nCurrent container status:" -ForegroundColor Cyan
    docker compose ps
    Write-Host "`nHeads-up: after a full reboot, Docker Desktop only starts once you SIGN IN." -ForegroundColor Yellow
    Write-Host "For unattended restarts (power blip while you're away), enable Windows auto-login" -ForegroundColor Yellow
    Write-Host "for this user so the desktop session — and Docker — comes back on its own." -ForegroundColor Yellow
  }
  'token'   {
    # 32 random bytes → hex. Paste into HOMUNCULUS_TOKEN in .env.
    $bytes = New-Object 'byte[]' 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Write-Host "Add this to .env as HOMUNCULUS_TOKEN:" -ForegroundColor Cyan
    Write-Host "HOMUNCULUS_TOKEN=$token"
  }
  'url' {
    # Best-effort Tailscale hostname lookup for a copy-paste phone URL.
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
      $name = (tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
      if ($name) {
        $tok = ''
        if (Test-Path '.env') {
          $line = Select-String -Path '.env' -Pattern '^HOMUNCULUS_TOKEN=(.+)$'
          if ($line) { $tok = "?token=" + $line.Matches[0].Groups[1].Value.Trim() }
        }
        Write-Host "Open on any Tailscale device: http://${name}:8787$tok" -ForegroundColor Green
        return
      }
    }
    Write-Host "Tailscale not detected. On the LAN, use http://<this-pc-ip>:8787" -ForegroundColor Yellow
  }
}
