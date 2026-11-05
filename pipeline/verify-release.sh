#!/usr/bin/env bash
# Fails unless the latest commit changes only the game folder (rule 15).
# Runs after the release commit and before anything is pushed or uploaded.
set -euo pipefail

outside="$(git diff --name-only --no-renames HEAD~1 HEAD | grep -v '^game/' || true)"
if [ -n "$outside" ]; then
  echo "Release blocked: it changes files outside the game folder:"
  echo "$outside"
  exit 1
fi
echo "Release only changes the game folder."
