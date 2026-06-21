#!/usr/bin/env bash
# release-preview.sh — build + preview semver bump + push preview branch
# Auto-detects npm latest, bumps (default patch +1), then appends -preview.TIMESTAMP
# Usage:
#   ./release-preview.sh                 → patch bump (1.6.9 → 1.6.10-preview.*)
#   ./release-preview.sh --minor         → minor bump (1.6.9 → 1.7.0-preview.*)
#   ./release-preview.sh --major         → major bump (1.6.9 → 2.0.0-preview.*)
#   ./release-preview.sh 1.8.0           → explicit base version
# npm publish is handled by .github/workflows/publish.yml through npm Trusted
# Publishing (OIDC). Desktop artifacts are built and attached by GitHub Actions
# after the GitHub prerelease is published.
set -euo pipefail

cd "$(dirname "$0")/.."

# ─── Flag parsing ──────────────────────────────────────
BUMP_KIND="patch"
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --with-desktop)
      echo "ℹ️  --with-desktop is no longer needed; GitHub Actions builds desktop assets after release publication."
      ;;
    --major|major)
      BUMP_KIND="major"
      ;;
    --minor|minor)
      BUMP_KIND="minor"
      ;;
    --patch|patch)
      BUMP_KIND="patch"
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
- Desktop app distribution remains separate from \`npm install -g cli-jaw\`.
- macOS, Windows, and Linux desktop assets are built by GitHub Actions after this prerelease is published, then attached to this GitHub Release."

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
NPM_LATEST=$(npm view cli-jaw dist-tags.latest 2>/dev/null || echo "")
PKG_VERSION=$(node -p "require('./package.json').version")

max_stable_version() {
  node - "$1" "$2" <<'NODE'
const values = process.argv.slice(2).map((value) => String(value || '0.0.0').replace(/-.*/, ''));
function parts(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map(Number);
}
values.sort((a, b) => {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
});
console.log(values[0]);
NODE
}

# Use the higher stable version from npm latest and package.json. This keeps
# preview releases ahead of npm without moving an ahead checkout backwards.
RAW_VERSION=$(max_stable_version "${NPM_LATEST:-0.0.0}" "$PKG_VERSION")

# Bump per BUMP_KIND so preview > latest in semver
IFS='.' read -r MAJOR MINOR PATCH <<< "$RAW_VERSION"
case "$BUMP_KIND" in
  major) BASE_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) BASE_VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) BASE_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
esac

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
echo "Preview version: $PREVIEW_VERSION  (base $RAW_VERSION + $BUMP_KIND bump)"
echo "Dist-tag:        preview"

# ─── Collect changelog from commits since last tag ─────
PREV_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]' | head -1)
if [ -n "$PREV_TAG" ]; then
  CHANGELOG=$(git log "$PREV_TAG"..HEAD -n 30 --pretty=format:"- %s" --no-merges)
  COMMIT_COUNT=$(git rev-list "$PREV_TAG"..HEAD --count)
else
  CHANGELOG=$(git log --oneline -10 --pretty=format:"- %s" --no-merges)
  COMMIT_COUNT="?"
fi

echo ""
echo "📝 Changes since $PREV_TAG ($COMMIT_COUNT commits):"
head -n 10 <<< "$CHANGELOG"
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

echo "🛡️  Running release gates (gate:all)..."
npm run gate:all

node scripts/require-release-evidence.mjs

echo "🧪 Verifying npm package contents..."
npm pack --dry-run >/dev/null

# ─── Commit + Push ────────────────────────────────────
echo "📝 Creating local commit..."
git add package.json package-lock.json
git commit -m "[agent] chore: preview v$VERSION" --allow-empty

echo "⬆️  Pushing preview branch..."
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" = "preview" ]; then
  git push origin preview
else
  echo "ℹ️  Current branch is $CURRENT_BRANCH; pushing HEAD to origin/preview."
  git push origin HEAD:preview
fi

# ─── GitHub Prerelease stub ────────────────────────────
echo "📋 Creating/updating GitHub prerelease stub..."
RELEASE_BODY="## Preview Release v$VERSION

**Base**: $RAW_VERSION → preview patch $BASE_VERSION
**Commits since $PREV_TAG**: $COMMIT_COUNT

### Changes
$CHANGELOG

### Publish
- npm preview publish runs from \`.github/workflows/publish.yml\` on the \`preview\` branch.
- npm dist-tag: \`preview\`
- Install after the workflow succeeds: \`npm install -g cli-jaw@preview\`

$ELECTRON_RELEASE_NOTES"

if command -v gh &>/dev/null; then
  if gh release view "v$VERSION" &>/dev/null; then
    gh release edit "v$VERSION" \
      --title "v$VERSION (preview)" \
      --notes "$RELEASE_BODY" \
      --prerelease
    echo "✅ GitHub prerelease v$VERSION updated!"
  else
    gh release create "v$VERSION" \
      --target "$(git rev-parse HEAD)" \
      --title "v$VERSION (preview)" \
      --notes "$RELEASE_BODY" \
      --prerelease
    echo "✅ GitHub prerelease v$VERSION created!"
  fi
  echo "🖥️  Desktop assets will be built by the Desktop Release GitHub Actions workflow."
else
  echo "⚠️  Skipped GitHub prerelease (gh CLI not found)"
fi

echo ""
echo "✅ Preview release queued: cli-jaw@$VERSION"
echo "   Install: npm install -g cli-jaw@preview"
echo "   Exact:   npm install -g cli-jaw@$VERSION"
echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
echo "   Workflow: https://github.com/lidge-jun/cli-jaw/actions/workflows/publish.yml?query=branch%3Apreview"
