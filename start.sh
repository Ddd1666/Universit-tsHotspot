#!/usr/bin/env sh
# Uni-Hotspot starten (Linux/macOS).  ./start.sh          -> Desktop-App (Electron)
#                                     ./start.sh browser  -> nur Server + Browser
set -e
cd "$(dirname "$0")"
export npm_config_cache="$PWD/.cache/npm"
export electron_config_cache="$PWD/.cache/electron"
export NODE_COMPILE_CACHE="$PWD/.cache/node-compile"
export npm_config_update_notifier=false

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nicht gefunden. Bitte Node.js 24 LTS installieren: https://nodejs.org/"
  exit 1
fi
node scripts/check-node.mjs

if ! node scripts/check-deps.mjs; then
  echo "Abhaengigkeiten werden installiert/aktualisiert ..."
  npm ci --no-audit --no-fund
  node scripts/check-deps.mjs --write
fi

if [ "$1" = "browser" ]; then
  exec node scripts/start.mjs --browser --open
else
  exec node scripts/start.mjs --desktop
fi
