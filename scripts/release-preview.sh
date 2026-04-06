#!/usr/bin/env bash
# release-preview.sh — build + preview semver bump + npm publish --tag preview
set -euo pipefail

cd "$(dirname "$0")/.."

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
npx vite build

echo "⬆️  Setting preview version..."
npm version "$PREVIEW_VERSION" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📌 package.json version: $VERSION"

echo "📝 Creating local commit..."
git add package.json package-lock.json
git commit -m "[agent] chore: preview v$VERSION" --allow-empty

echo "🏷️  Creating preview tag..."
git tag "v$VERSION"

echo "⬆️  Pushing branch + tag..."
git push origin master
git push origin "v$VERSION"

echo "🚀 Publishing preview to npm..."
npm publish --tag preview --access public

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
