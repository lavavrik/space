#!/usr/bin/env bash
# Deploy the build to orbcloud (docs/deploy.md): the `ui` webserver of the `space` project,
# environment `space`, serving https://space-ui-221ebc30.orbcloud.io. Builds, then uploads
# every asset and index.html last. Needs `occ` logged in.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE=221ebc30-93ed-41cc-8b77-181e25bfeaf4

# occ reports overwriting an existing file as "failed (204)": 204 is the server's success. Anything
# else stops the deploy (an asset that didn't overwrite stopped it before the new script went up, and
# index.html, uploaded by hand, pointed at a script that wasn't there)
upload() {
  local out
  if ! out=$(occ services webserver files upload "$SERVICE" "$1" "$2" 2>&1); then
    grep -q 'failed (204)' <<<"$out" || { echo "$out" >&2; return 1; }
  fi
  echo "Uploaded $1"
}

npm run build
# assets first, index.html last: a visitor never gets an index pointing at assets not uploaded yet
for f in $(cd dist && find assets -type f); do
  upload "dist/$f" "$f"
done
upload dist/index.html index.html
echo "Deployed: https://space-ui-221ebc30.orbcloud.io"
