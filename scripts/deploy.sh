#!/usr/bin/env bash
# Deploy the build to orbcloud (docs/deploy.md): the `ui` webserver of the `commonsafe` project,
# environment `commonsafe`, serving https://commonsafe-ui-10d32890.orbcloud.io. Builds, then uploads
# every asset and index.html last. Needs `occ` logged in.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE=10d32890-180a-40c1-9467-081b442622ff

npm run build
# assets first, index.html last: a visitor never gets an index pointing at assets not uploaded yet
for f in $(cd dist && find assets -type f); do
  occ services webserver files upload "$SERVICE" "dist/$f" "$f"
done
# (occ reports overwriting an existing file as "failed (204)": 204 is the server's success)
occ services webserver files upload "$SERVICE" dist/index.html index.html || true
echo "Deployed: https://commonsafe-ui-10d32890.orbcloud.io"
