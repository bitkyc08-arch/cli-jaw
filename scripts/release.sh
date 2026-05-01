#!/usr/bin/env bash
# release.sh — 빌드 + 버전업 + npm publish + GitHub Release 한 번에 처리
# Auto-detects npm latest and bumps patch only (minor/major via explicit arg).
# Usage:
#   ./release.sh          → patch bump (1.6.9 → 1.6.10)
#   ./release.sh minor    → minor bump (1.6.9 → 1.7.0)
#   ./release.sh major    → major bump (1.6.9 → 2.0.0)
#   ./release.sh 1.8.0    → explicit version
set -e

echo "🦈 cli-jaw release script"
echo "========================="

cd "$(dirname "$0")/.."

# ─── Flag parsing ──────────────────────────────────────
WITH_DESKTOP=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --with-desktop)
      WITH_DESKTOP=1
      ;;
    *)
      POSITIONAL+=("$arg")
      ;;
  esac
done
set -- "${POSITIONAL[@]}"

run_electron_release_checks() {
  echo "🖥️  Checking Electron npm boundary..."
  npm run check:electron-no-native

  echo "🖥️  Type checking Electron shell..."
  npm --prefix electron run typecheck

  echo "🖥️  Building Electron shell..."
  npm --prefix electron run build
}

ELECTRON_RELEASE_NOTES_BASE="### Desktop / Electron
- Electron shell validated with \`npm --prefix electron run typecheck\` and \`npm --prefix electron run build\`.
- npm package boundary validated with \`npm run check:electron-no-native\`; Electron app artifacts remain outside the npm package.
- Desktop app distribution remains separate from \`npm install -g cli-jaw\` and should be shipped through the GitHub/download channel."

ELECTRON_RELEASE_NOTES_UNSIGNED="
#### ⚠️ Desktop app downloads are unsigned
The macOS \`.dmg\` / \`.zip\` and Windows installers attached to this release are **unsigned** (no Apple Developer ID / Windows code-signing cert configured).

- macOS: Gatekeeper will block first launch. Either right-click → Open → Open, or remove the quarantine attribute:
  \`\`\`sh
  xattr -d com.apple.quarantine /Applications/cli-jaw.app
  \`\`\`
- Windows: SmartScreen will warn on first run. Click \"More info\" → \"Run anyway\".
- For trusted distribution, install via \`npm install -g cli-jaw\` instead."

ELECTRON_RELEASE_NOTES="$ELECTRON_RELEASE_NOTES_BASE"
if [ "$WITH_DESKTOP" = "1" ]; then
  ELECTRON_RELEASE_NOTES="$ELECTRON_RELEASE_NOTES_BASE$ELECTRON_RELEASE_NOTES_UNSIGNED"
fi

# ─── Version detection ─────────────────────────────────
NPM_LATEST=$(npm view cli-jaw dist-tags.latest 2>/dev/null || echo "0.0.0")
PKG_VERSION=$(node -p "require('./package.json').version")
echo "📡 npm latest:   $NPM_LATEST"
echo "📦 package.json: $PKG_VERSION"

# Sync package.json to npm latest if behind (strip prerelease)
CLEAN_NPM=$(echo "$NPM_LATEST" | sed 's/-.*//')
CLEAN_PKG=$(echo "$PKG_VERSION" | sed 's/-.*//')
if [ "$CLEAN_PKG" != "$CLEAN_NPM" ] && [ "$CLEAN_NPM" != "0.0.0" ]; then
  echo "⚠️  package.json ($CLEAN_PKG) differs from npm ($CLEAN_NPM). Syncing..."
  npm version "$CLEAN_NPM" --no-git-tag-version --allow-same-version
fi

# ─── Build ─────────────────────────────────────────────
echo "📦 Building backend (tsc)..."
./node_modules/.bin/tsc

echo "📦 Building frontend (vite)..."
npx vite build

run_electron_release_checks

# ─── Version bump ──────────────────────────────────────
BUMP_ARG="${1:-patch}"

# If arg looks like a semver (x.y.z), use it directly
if [[ "$BUMP_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  npm version "$BUMP_ARG" --no-git-tag-version
else
  # patch (default), minor, or major
  npm version "$BUMP_ARG" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
echo "📌 New version: $VERSION"

# ─── Desktop dist (optional, --with-desktop) ───────────
DESKTOP_ARTIFACTS=()
if [ "$WITH_DESKTOP" = "1" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "🖥️  Building desktop app (unsigned)..."
    rm -rf electron/dist
    CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix electron run dist:mac
    while IFS= read -r f; do
      [ -n "$f" ] && DESKTOP_ARTIFACTS+=("$f")
    done < <(ls electron/dist/*.dmg electron/dist/*.zip 2>/dev/null || true)
    echo "📦 Desktop artifacts collected: ${#DESKTOP_ARTIFACTS[@]}"
    printf '   - %s\n' "${DESKTOP_ARTIFACTS[@]}"
  else
    echo "⚠️  --with-desktop requested but host is not Darwin; skipping macOS dist."
  fi
fi

# ─── Collect changelog ─────────────────────────────────
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)
if [ -n "$PREV_TAG" ]; then
  CHANGELOG=$(git log "$PREV_TAG"..HEAD --pretty=format:"- %s" --no-merges | head -50)
  COMMIT_COUNT=$(git rev-list "$PREV_TAG"..HEAD --count)
else
  CHANGELOG=$(git log --oneline -20 --pretty=format:"- %s" --no-merges)
  COMMIT_COUNT="?"
fi

echo ""
echo "📝 Changes since ${PREV_TAG:-'(none)'} ($COMMIT_COUNT commits):"
echo "$CHANGELOG" | head -15
echo ""

# ─── Commit + Tag + Push ──────────────────────────────
echo "🏷️  Creating git tag v$VERSION..."
git add package.json package-lock.json
git commit -m "[agent] chore: release v$VERSION" --allow-empty
git tag "v$VERSION"
git push origin master
git push origin "v$VERSION"

# ─── npm publish ───────────────────────────────────────
echo "🚀 Publishing to npm..."
npm publish --access public

# ─── GitHub Release with changelog ─────────────────────
echo "📋 Creating GitHub Release..."
RELEASE_BODY="## Release v$VERSION

**Previous**: ${PREV_TAG:-'(first release)'}
**Commits**: $COMMIT_COUNT

### Changes
$CHANGELOG

$ELECTRON_RELEASE_NOTES"

if [ -n "$PREV_TAG" ] && command -v gh &>/dev/null; then
    gh release create "v$VERSION" \
        --title "v$VERSION" \
        --notes "$RELEASE_BODY" \
        --latest \
        "${DESKTOP_ARTIFACTS[@]}"
    echo "✅ GitHub Release v$VERSION created!"
else
    echo "⚠️  Skipped GitHub Release (gh CLI not found or no previous tag)"
fi

echo ""
echo "✅ cli-jaw@$VERSION published!"
echo "   Install: npm install -g cli-jaw"
echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
