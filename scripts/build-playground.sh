#!/bin/bash
set -e

# Build the Vite playground and copy it into website/public/playground/
# Usage: ./scripts/build-playground.sh
# Set VITE_PACKAGE_SERVER_URL to override the ESM server (default: https://esm.reactnative.run)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE_DIR="$REPO_ROOT/browser-metro/example"
DEST_DIR="$REPO_ROOT/website/public/playground"

export VITE_PACKAGE_SERVER_URL="${VITE_PACKAGE_SERVER_URL:-https://esm.reactnative.run}"

echo "Building browser-metro library..."
npm run build --prefix "$REPO_ROOT/browser-metro"

echo "Building playground (ESM server: $VITE_PACKAGE_SERVER_URL)..."
cd "$EXAMPLE_DIR" && npx tsx scripts/build-projects.ts && npx vite build --base /playground/

echo "Copying to website/public/playground/..."
rm -rf "$DEST_DIR"
cp -r "$EXAMPLE_DIR/dist" "$DEST_DIR"

echo "Done. Playground assets at: $DEST_DIR"
