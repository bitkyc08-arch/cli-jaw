#!/usr/bin/env bash
# release.sh — 빌드 + 버전업 + npm publish를 한 번에 처리
set -e

echo "🦈 cli-jaw release script"
echo "========================="

# 1. TypeScript 빌드
echo "📦 Building backend (tsc)..."
./node_modules/.bin/tsc

# 2. Frontend 번들링
echo "📦 Building frontend (esbuild)..."
node esbuild.config.mjs

# 3. 버전 bump (patch)
BUMP=${1:-patch}  # 기본 patch, 인자로 minor/major 가능
echo "⬆️  Version bump: $BUMP"
npm version "$BUMP" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
echo "📌 New version: $VERSION"

# 4. npm publish
echo "🚀 Publishing to npm..."
npm publish --access public

echo ""
echo "✅ cli-jaw@$VERSION published!"
echo "   Install: npm install -g cli-jaw"
