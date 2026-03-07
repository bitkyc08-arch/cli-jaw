#!/usr/bin/env bash
# release-preview.sh — build + preview semver bump + npm publish --tag preview
set -euo pipefail

BASE_VERSION="${1:-1.4.0}"
PREID="${PREID:-preview}"
STAMP="${STAMP:-$(date +%Y%m%d%H%M%S)}"

if [[ ! "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ BASE_VERSION must look like 1.4.0"
  exit 1
fi

PREVIEW_VERSION="${BASE_VERSION}-${PREID}.${STAMP}"

echo "🦈 cli-jaw preview release script"
echo "================================="
echo "Base version:    $BASE_VERSION"
echo "Preview version: $PREVIEW_VERSION"
echo "Dist-tag:        preview"

echo ""
echo "🔎 Type checking..."
pnpm exec tsc --noEmit

echo "📦 Building backend..."
npm run build

echo "📦 Building frontend..."
node esbuild.config.mjs

echo "⬆️  Setting preview version..."
npm version "$PREVIEW_VERSION" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📌 package.json version: $VERSION"

echo "📝 Creating local commit..."
git add package.json package-lock.json
git commit -m "[agent] chore: preview v$VERSION" --allow-empty

echo "🚀 Publishing preview to npm..."
npm publish --tag preview --access public

echo ""
echo "✅ Preview published: cli-jaw@$VERSION"
echo "   Install: npm install -g cli-jaw@preview"
echo "   Exact:   npm install -g cli-jaw@$VERSION"
