#!/usr/bin/env bash
# Publish the app (and the HTML user guide) to a VDS over SSH.
#
#   VDS_HOST=1.2.3.4 VDS_USER=deploy VDS_PATH=/var/www/salsa-radar \
#   VDS_KEY=~/.ssh/id_ed25519 scripts/deploy.sh
#
# Result on the server:
#   $VDS_PATH/index.html      — the app (static PWA; microphone needs HTTPS)
#   $VDS_PATH/guide.html      — self-contained user guide
# Nothing outside $VDS_PATH is touched; existing files there are overwritten, not deleted.
set -euo pipefail

: "${VDS_HOST:?set VDS_HOST}"
: "${VDS_USER:?set VDS_USER}"
: "${VDS_PATH:?set VDS_PATH (absolute directory served by the web server)}"
case "$VDS_PATH" in /*) ;; *) echo "VDS_PATH must be absolute" >&2; exit 1 ;; esac
[ "$VDS_PATH" = "/" ] && { echo "refusing to deploy to /" >&2; exit 1; }

SSH=(ssh -o BatchMode=yes)
[ -n "${VDS_KEY:-}" ] && SSH+=(-i "$VDS_KEY")

cd "$(dirname "$0")/.."
npm run build
npm run -s guide
cp docs/user-guide.html dist/guide.html

"${SSH[@]}" "$VDS_USER@$VDS_HOST" "mkdir -p '$VDS_PATH'"
rsync -az -e "${SSH[*]}" dist/ "$VDS_USER@$VDS_HOST:$VDS_PATH/"
echo "Deployed to $VDS_USER@$VDS_HOST:$VDS_PATH (app: index.html, guide: guide.html)"
