# Installs every mod in this repo for your user, so they load in every project.
# Run from PowerShell:  ./install-all.ps1
# From a clone of the repo, add -Local to install from this folder instead of GitHub.

param([switch]$Local)

$ErrorActionPreference = "Stop"
$mods = @("waypoint", "limit-meter", "token-weather", "blast-radius", "replay-theater", "files-seen", "session-journal", "agent-farm", "code-pet")

if ($Local) {
  claude plugin marketplace add $PSScriptRoot
} else {
  claude plugin marketplace add Alyan-khattak/claude-code-mods
}

foreach ($m in $mods) {
  Write-Host "Installing $m..."
  claude plugin install "$m@alyan-mods" --scope user
}

Write-Host ""
Write-Host "Done. Start a new Claude Code session (or run /reload-plugins) to load the mods."
