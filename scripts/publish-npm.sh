#!/usr/bin/env bash
# Publish the four packages to npm in dependency order: core → widget, relay → CLI.
# Safe to re-run: versions that are already on npm are skipped.
# Run from the repo root:  bash scripts/publish-npm.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ Installing, building and testing…"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
npx vitest run

echo
echo "▸ Checking your npm login…"
if ! npm whoami >/dev/null 2>&1; then
  echo "  Not logged in. npm will open your browser to sign in."
  npm login --auth-type=web
fi
echo "  Logged in as $(npm whoami)."

echo
SCOPE=pixelatlarge
echo "▸ Checking you can publish to @${SCOPE}…"
until [ "$(npm whoami)" = "${SCOPE}" ] || npm org ls "${SCOPE}" >/dev/null 2>&1; do
  echo "  You're logged in as '$(npm whoami)'. The @${SCOPE} packages need either that npm"
  echo "  username, or a free npm organization named '${SCOPE}' that you own:"
  echo "    https://www.npmjs.com/org/create"
  read -r -p "  Press return once that's sorted (or Ctrl-C to stop)… " _
done
echo "  OK."

echo
for p in core widget relay cli; do
  name=$(node -p "require('./packages/${p}/package.json').name")
  version=$(node -p "require('./packages/${p}/package.json').version")
  if npm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "▸ ${name}@${version} is already on npm, skipping."
  else
    echo "▸ Publishing ${name}@${version}…"
    npm publish -w "packages/${p}"
  fi
done

echo
echo "✔ Done. Packages:"
for p in core widget relay cli; do
  name=$(node -p "require('./packages/${p}/package.json').name")
  echo "  https://www.npmjs.com/package/${name}"
done
