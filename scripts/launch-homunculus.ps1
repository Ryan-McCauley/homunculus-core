# Launch Homunculus: start the backend if it isn't already up, then open the desktop
# shell. Used by the desktop shortcut. Safe to run repeatedly — it never starts a
# second server.
#
# The Electron shell (not a browser) is the launch surface on purpose: key entry in
# SETTINGS → KEYS needs the OS keychain, which only exists there. Pass -Browser to
# open the web UI instead.
param([switch]$Browser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 8787
$url  = "http://127.0.0.1:$port"

# Plain TCP check: no proxy, no IPv6-first stall, no HTTP stack surprises.
function Test-Homunculus {
    $c = New-Object Net.Sockets.TcpClient
    try {
        $ok = $c.BeginConnect('127.0.0.1', $port, $null, $null).AsyncWaitHandle.WaitOne(1000)
        return $ok -and $c.Connected
    } catch { return $false } finally { $c.Close() }
}

if (-not (Test-Homunculus)) {
    Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','start' `
        -WorkingDirectory $root -WindowStyle Minimized

    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline -and -not (Test-Homunculus)) {
        Start-Sleep -Milliseconds 750
    }

    if (-not (Test-Homunculus)) {
        [void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
        [Windows.Forms.MessageBox]::Show(
            "Homunculus backend did not come up on $url within 120s.`nCheck the minimized server window for errors.",
            'Homunculus') | Out-Null
        exit 1
    }
}

if ($Browser) {
    Start-Process "http://localhost:$port"
} else {
    Start-Process -FilePath 'npx.cmd' -ArgumentList 'electron','.' `
        -WorkingDirectory $root -WindowStyle Hidden
}
