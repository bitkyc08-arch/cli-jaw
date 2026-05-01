#!/usr/bin/env bash
# release-preview.sh — build + preview semver bump + npm publish --tag preview
# Auto-detects npm latest, bumps patch +1, then appends -preview.TIMESTAMP
# Example: npm latest = 1.6.9 → preview = 1.6.10-preview.20260414153000
set -euo pipefail

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
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

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
NPM_LATEST=$(npm view cli-jaw dist-tags.latest 2>/dev/null || echo "")
PKG_VERSION=$(node -p "require('./package.json').version")

# Use npm latest > package.json, strip prerelease suffix
RAW_VERSION="${NPM_LATEST:-$PKG_VERSION}"
RAW_VERSION=$(echo "$RAW_VERSION" | sed 's/-.*//')

# Bump patch +1 for preview (so preview > latest in semver)
IFS='.' read -r MAJOR MINOR PATCH <<< "$RAW_VERSION"
NEXT_PATCH=$((PATCH + 1))
BASE_VERSION="${MAJOR}.${MINOR}.${NEXT_PATCH}"

# Allow explicit override: ./release-preview.sh 2.0.0
if [ "${1:-}" != "" ]; then
  BASE_VERSION="$1"
fi

PREID="${PREID:-preview}"
STAMP="${STAMP:-$(date +%Y%m%d%H%M%S)}"

if [[ ! "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ BASE_VERSION must look like 1.6.10 (got: $BASE_VERSION)"
  exit 1
fi

PREVIEW_VERSION="${BASE_VERSION}-${PREID}.${STAMP}"

echo "🦈 cli-jaw preview release script"
echo "================================="
echo "npm latest:      ${NPM_LATEST:-'(not found)'}"
echo "package.json:    $PKG_VERSION"
echo "Preview version: $PREVIEW_VERSION  (base $RAW_VERSION + patch bump)"
echo "Dist-tag:        preview"

# ─── Collect changelog from commits since last tag ─────
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)
if [ -n "$PREV_TAG" ]; then
  CHANGELOG=$(git log "$PREV_TAG"..HEAD --pretty=format:"- %s" --no-merges | head -30)
  COMMIT_COUNT=$(git rev-list "$PREV_TAG"..HEAD --count)
else
  CHANGELOG=$(git log --oneline -10 --pretty=format:"- %s" --no-merges)
  COMMIT_COUNT="?"
fi

echo ""
echo "📝 Changes since $PREV_TAG ($COMMIT_COUNT commits):"
echo "$CHANGELOG" | head -10
echo ""

# ─── Build ─────────────────────────────────────────────
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

run_electron_release_checks

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
    printf '   - %s\n' "${DESKTOP_ARTIFACTS[@]+"${DESKTOP_ARTIFACTS[@]}"}"
  else
    echo "⚠️  --with-desktop requested but host is not Darwin; skipping macOS dist."
  fi
fi

echo "🧪 Verifying npm package contents..."
npm pack --dry-run >/dev/null

# ─── Commit + Publish ─────────────────────────────────
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

# ─── GitHub Prerelease with changelog ──────────────────
echo "📋 Creating GitHub prerelease..."
RELEASE_BODY="## Preview Release v$VERSION

**Base**: $RAW_VERSION → preview patch $BASE_VERSION
**Commits since $PREV_TAG**: $COMMIT_COUNT

### Changes
$CHANGELOG

$ELECTRON_RELEASE_NOTES"

if command -v gh &>/dev/null; then
  gh release create "v$VERSION" \
    --title "v$VERSION (preview)" \
    --notes "$RELEASE_BODY" \
    --prerelease \
    "${DESKTOP_ARTIFACTS[@]+"${DESKTOP_ARTIFACTS[@]}"}"
  echo "✅ GitHub prerelease v$VERSION created!"
else
  echo "⚠️  Skipped GitHub prerelease (gh CLI not found)"
fi

echo ""
echo "✅ Preview published: cli-jaw@$VERSION"
echo "   Install: npm install -g cli-jaw@preview"
echo "   Exact:   npm install -g cli-jaw@$VERSION"
echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
