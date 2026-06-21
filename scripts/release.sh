#!/usr/bin/env bash
# release.sh — 빌드 + 버전업 + GitHub Release stub + publish workflow trigger
# Auto-detects npm latest and bumps patch only (minor/major via explicit arg).
# Usage:
#   ./release.sh          → patch bump (1.6.9 → 1.6.10)
#   ./release.sh minor    → minor bump (1.6.9 → 1.7.0)
#   ./release.sh major    → major bump (1.6.9 → 2.0.0)
#   ./release.sh 1.8.0    → explicit version
# Desktop artifacts are built and attached by GitHub Actions after the
# GitHub Release is published.
set -e

echo "🦈 cli-jaw release script"
echo "========================="

cd "$(dirname "$0")/.."

# ─── Flag parsing ──────────────────────────────────────
POSITIONAL=()
REQUIRE_EVIDENCE=false
for arg in "$@"; do
  case "$arg" in
    --require-evidence)
      REQUIRE_EVIDENCE=true
      ;;
    --with-desktop)
      echo "ℹ️  --with-desktop is no longer needed; GitHub Actions builds desktop assets after release publication."
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
- Desktop app distribution remains separate from \`npm install -g cli-jaw\`.
- macOS, Windows, and Linux desktop assets are built by GitHub Actions after this release is published, then attached to this GitHub Release."

ELECTRON_RELEASE_NOTES_UNSIGNED="
#### ⚠️ Desktop app downloads are unsigned
The desktop assets attached by GitHub Actions are **unsigned** (no Apple Developer ID / Windows code-signing cert configured).

- macOS: Gatekeeper will block first launch. Either right-click → Open → Open, or remove the quarantine attribute:
  \`\`\`sh
  xattr -d com.apple.quarantine /Applications/cli-jaw.app
  \`\`\`
- Windows: SmartScreen will warn on first run. Click \"More info\" → \"Run anyway\".
- Linux: AppImage downloads may need execute permission before launch.
- For trusted distribution, install via \`npm install -g cli-jaw\` instead."

ELECTRON_RELEASE_NOTES="$ELECTRON_RELEASE_NOTES_BASE$ELECTRON_RELEASE_NOTES_UNSIGNED"

# ─── Version detection ─────────────────────────────────
NPM_LATEST=$(npm view cli-jaw dist-tags.latest 2>/dev/null || echo "0.0.0")
PKG_VERSION=$(node -p "require('./package.json').version")
echo "📡 npm latest:   $NPM_LATEST"
echo "📦 package.json: $PKG_VERSION"

PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)

semver_cmp() {
  node - "$1" "$2" <<'NODE'
const [a, b] = process.argv.slice(2).map((value) => String(value || '0.0.0').replace(/-.*/, ''));
function parts(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map(Number);
}
const pa = parts(a);
const pb = parts(b);
for (let i = 0; i < 3; i += 1) {
  if (pa[i] > pb[i]) process.exit(1);
  if (pa[i] < pb[i]) process.exit(2);
}
process.exit(0);
NODE
}

# Sync package.json to npm latest only if this checkout is behind npm.
# Never move a release checkout backwards just because npm latest has not
# caught up yet; failed OTP publishes commonly leave local tags ahead.
CLEAN_NPM=$(echo "$NPM_LATEST" | sed 's/-.*//')
CLEAN_PKG=$(echo "$PKG_VERSION" | sed 's/-.*//')
if [ "$CLEAN_PKG" != "$CLEAN_NPM" ] && [ "$CLEAN_NPM" != "0.0.0" ]; then
  CMP=0
  semver_cmp "$CLEAN_PKG" "$CLEAN_NPM" || CMP=$?
  if [ "$CMP" -eq 2 ]; then
    echo "⚠️  package.json ($CLEAN_PKG) is behind npm ($CLEAN_NPM). Syncing forward..."
    npm version "$CLEAN_NPM" --no-git-tag-version --allow-same-version
  else
    echo "ℹ️  package.json ($CLEAN_PKG) is ahead of npm ($CLEAN_NPM); keeping checkout version."
  fi
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

# ─── Collect changelog ─────────────────────────────────
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

# ─── Release gates ────────────────────────────────────
echo "🛡️  Running release gates (gate:all)..."
npm run gate:all

if [ "$REQUIRE_EVIDENCE" = true ]; then
  node scripts/require-release-evidence.mjs
else
  node scripts/require-release-evidence.mjs || echo "⚠️  Evidence gate skipped (pass --require-evidence to enforce)"
fi

# ─── Commit + Tag + Push ──────────────────────────────
echo "🏷️  Creating git tag v$VERSION..."
git add package.json package-lock.json
git commit -m "[agent] chore: release v$VERSION" --allow-empty
git tag "v$VERSION"
git push origin master
git push origin "v$VERSION"

# ─── GitHub Release with changelog ─────────────────────
# IMPORTANT: create/update the GitHub Release stub before the publish workflow.
# npm publishing is handled by .github/workflows/publish.yml through GitHub OIDC
# Trusted Publishing after the master/main push. Keeping the release record in
# GitHub first makes the release visible and gives desktop-release.yml a stable
# release target for artifact uploads.
echo "📋 Creating GitHub Release..."
RELEASE_BODY="## Release v$VERSION

**Previous**: ${PREV_TAG:-'(first release)'}
**Commits**: $COMMIT_COUNT

### Changes
$CHANGELOG

$ELECTRON_RELEASE_NOTES"

RELEASE_CREATED=false
if command -v gh &>/dev/null; then
    if gh release view "v$VERSION" &>/dev/null; then
        echo "ℹ️  GitHub Release v$VERSION already exists — updating notes."
        gh release edit "v$VERSION" --title "v$VERSION" --notes "$RELEASE_BODY" --latest \
            && RELEASE_CREATED=true \
            || echo "⚠️  Failed to update existing GitHub Release v$VERSION (continuing)."
    elif gh release create "v$VERSION" --title "v$VERSION" --notes "$RELEASE_BODY" --latest; then
        RELEASE_CREATED=true
        echo "✅ GitHub Release v$VERSION created!"
        echo "🖥️  Desktop assets will be built by the Desktop Release GitHub Actions workflow."
    else
        # Do NOT abort: the tag is already pushed and we still want to publish.
        # Surface loudly so the release can be backfilled manually.
        echo "❌ GitHub Release v$VERSION FAILED to create. Tag is pushed; backfill with:"
        echo "   gh release create v$VERSION --title v$VERSION --notes-file <(...) --latest"
    fi
else
    echo "⚠️  Skipped GitHub Release (gh CLI not found)"
fi

# ─── npm publish ───────────────────────────────────────
echo "🚀 npm publish is handled by .github/workflows/publish.yml after the master/main push."
echo "   Workflow: https://github.com/lidge-jun/cli-jaw/actions/workflows/publish.yml?query=branch%3Amaster"

echo ""
echo "✅ cli-jaw@$VERSION release queued!"
echo "   Install: npm install -g cli-jaw"
if [ "$RELEASE_CREATED" = true ]; then
    echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
else
    echo "   ⚠️  GitHub Release for v$VERSION was NOT created — backfill it manually."
fi
