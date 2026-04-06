#!/usr/bin/env bash
# release.sh — 빌드 + 버전업 + npm publish + GitHub Release 한 번에 처리
set -e

echo "🦈 cli-jaw release script"
echo "========================="

# cd to project root (parent of scripts/)
cd "$(dirname "$0")/.."

# 1. TypeScript 빌드
echo "📦 Building backend (tsc)..."
./node_modules/.bin/tsc

# 2. Frontend 번들링 (Vite)
echo "📦 Building frontend (vite)..."
npx vite build

# 3. 버전 bump (patch)
BUMP=${1:-patch}  # 기본 patch, 인자로 minor/major 가능
echo "⬆️  Version bump: $BUMP"
npm version "$BUMP" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📌 New version: $VERSION"

# 4. git commit + tag
echo "🏷️  Creating git tag v$VERSION..."
git add package.json package-lock.json
git commit -m "[agent] chore: release v$VERSION" --allow-empty
git tag "v$VERSION"
git push origin master
git push origin "v$VERSION"

# 5. npm publish
echo "🚀 Publishing to npm..."
npm publish --access public

# 6. GitHub Release (auto-generate notes from commits since last tag)
echo "📋 Creating GitHub Release..."
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v' | sed -n '2p')
if [ -n "$PREV_TAG" ] && command -v gh &>/dev/null; then
    gh release create "v$VERSION" \
        --title "v$VERSION" \
        --generate-notes \
        --notes-start-tag "$PREV_TAG" \
        --latest
    echo "✅ GitHub Release v$VERSION created!"
else
    echo "⚠️  Skipped GitHub Release (gh CLI not found or no previous tag)"
fi

echo ""
echo "✅ cli-jaw@$VERSION published!"
echo "   Install: npm install -g cli-jaw"
echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
