#!/usr/bin/env bash
# release-preview.sh — build + preview semver bump + npm publish --tag preview
# Auto-detects the latest npm version and creates a preview on top of it.
set -euo pipefail

cd "$(dirname "$0")/.."

# Auto-detect base version from npm registry (latest tag)
NPM_LATEST=$(npm view cli-jaw dist-tags.latest 2>/dev/null || echo "")
PKG_VERSION=$(node -p "require('./package.json').version")

# Use explicit arg > npm latest > package.json
BASE_VERSION="${1:-${NPM_LATEST:-$PKG_VERSION}}"
# Strip any existing prerelease suffix (e.g., 1.6.9-preview.xxx → 1.6.9)
BASE_VERSION=$(echo "$BASE_VERSION" | sed 's/-.*//')

PREID="${PREID:-preview}"
STAMP="${STAMP:-$(date +%Y%m%d%H%M%S)}"

if [[ ! "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ BASE_VERSION must look like 1.6.9 (got: $BASE_VERSION)"
  exit 1
fi

PREVIEW_VERSION="${BASE_VERSION}-${PREID}.${STAMP}"

echo "🦈 cli-jaw preview release script"
echo "================================="
echo "npm latest:      ${NPM_LATEST:-'(not found)'}"
echo "package.json:    $PKG_VERSION"
echo "Base version:    $BASE_VERSION"
echo "Preview version: $PREVIEW_VERSION"
echo "Dist-tag:        preview"

echo ""
echo "⬆️  Setting preview version..."
npm version "$PREVIEW_VERSION" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📌 package.json version: $VERSION"

echo "🔎 Type checking..."
pnpm exec tsc --noEmit

echo "📦 Building backend..."
npm run build

echo "📦 Building frontend..."
npm run build:frontend

echo "🧪 Verifying npm package contents..."
npm pack --dry-run >/dev/null

echo "📝 Creating local commit..."
git add package.json package-lock.json
git commit -m "[agent] chore: preview v$VERSION" --allow-empty

echo "🚀 Publishing preview to npm..."
TARBALL="$(npm pack | tail -1)"
trap 'rm -f "$TARBALL"' EXIT
npm publish "$TARBALL" --tag preview --access public

echo "🏷️  Creating preview tag..."
git tag "v$VERSION"

echo "⬆️  Pushing branch + tag..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "$CURRENT_BRANCH"
git push origin "v$VERSION"

echo "📋 Creating GitHub prerelease..."
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v' | grep -v "^v$VERSION$" | head -1)
if command -v gh &>/dev/null; then
  if [ -n "$PREV_TAG" ]; then
    gh release create "v$VERSION" \
      --title "v$VERSION" \
      --generate-notes \
      --notes-start-tag "$PREV_TAG" \
      --prerelease
  else
    gh release create "v$VERSION" \
      --title "v$VERSION" \
      --generate-notes \
      --prerelease
  fi
  echo "✅ GitHub prerelease v$VERSION created!"
else
  echo "⚠️  Skipped GitHub prerelease (gh CLI not found)"
fi

echo ""
echo "✅ Preview published: cli-jaw@$VERSION"
echo "   Install: npm install -g cli-jaw@preview"
echo "   Exact:   npm install -g cli-jaw@$VERSION"
echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
