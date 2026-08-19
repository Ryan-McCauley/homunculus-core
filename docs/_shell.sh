#!/usr/bin/env bash
# Assemble a docs page: _shell.sh <slug> <Title> <Lede> < body.frag > slug.html
set -euo pipefail
slug="$1"; title="$2"; lede="$3"
nav() { # $1=href $2=label
  if [ "$1" = "$slug.html" ]; then
    printf '  <a href="%s" class="active">%s</a>\n' "$1" "$2"
  else
    printf '  <a href="%s">%s</a>\n' "$1" "$2"
  fi
}
cat <<HEAD
<!doctype html>
<html lang="en" data-theme="prism">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$title — Homunculus Core Docs</title>
<link rel="stylesheet" href="prism.css">
</head>
<body>
<div class="holo-rule top"></div>
<header class="site-header">
  <a class="wordmark" href="index.html">HOMUNCULUS CORE</a>
  <span class="sub">Documentation</span>
</header>

<div class="layout">
<nav class="sidebar">
  <div class="group">Start Here</div>
HEAD
nav index.html "Overview"
nav getting-started.html "Getting Started"
nav faq.html "FAQ &amp; Troubleshooting"
echo '
  <div class="group">Using the Bridge</div>'
nav widgets-layout.html "Widgets &amp; Layout"
nav computer-core.html "Computer Core"
nav tab-bridge.html "BRIDGE Tab"
nav tab-osint.html "OSINT Tab"
nav tab-home.html "HOME Tab (Home Assistant)"
nav tab-data.html "DATA Tab"
nav tab-archive.html "ARCHIVE Tab"
nav tab-crypto.html "CRYPTO Tab"
echo '
  <div class="group">Deploy &amp; Operate</div>'
nav deployment.html "Deployment"
nav configuration.html "Configuration Reference"
nav security.html "Security"
nav upgrading.html "Upgrading"
echo '
  <div class="group">Development</div>'
nav architecture.html "Architecture"
nav protocol.html "WebSocket Protocol"
nav widget-development.html "Widget Development"
nav backend-modules.html "Backend Modules"
nav screener-engine.html "Screener Engine"
nav contributing.html "Contributing &amp; Testing"
cat <<MID
</nav>

<main class="content">
<h1>$title</h1>
<p class="lede">$lede</p>

MID
cat
cat <<FOOT

</main>
</div>

<footer class="site-footer">Homunculus Core — starship-bridge command interface</footer>
</body>
</html>
FOOT
