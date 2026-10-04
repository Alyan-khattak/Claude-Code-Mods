#!/usr/bin/env sh
# Installs every mod in this repo for your user, so they load in every project.
# Run:  sh install-all.sh          (installs from GitHub)
#       sh install-all.sh --local  (from a clone: installs from this folder)
set -e

MODS="waypoint limit-meter token-weather blast-radius replay-theater files-seen session-journal agent-farm code-pet"

if [ "$1" = "--local" ]; then
  claude plugin marketplace add "$(cd "$(dirname "$0")" && pwd)"
else
  claude plugin marketplace add Alyan-khattak/claude-code-mods
fi

for m in $MODS; do
  echo "Installing $m..."
  claude plugin install "$m@alyan-mods" --scope user
done

echo ""
echo "Done. Start a new Claude Code session (or run /reload-plugins) to load the mods."
