#!/usr/bin/env bash
# promote-to-main.sh — dev-first release promotion (issue #333).
#
# Replaces release.sh. The old flow created the version bump commit on whatever
# branch was checked out and pushed it straight to origin/main, so main ended up
# ahead of dev by the release commit and the publish workflow fired on the raw
# push. New flow:
#
#   1. Run from a clean dev checkout (HEAD must equal origin/dev).
#   2. Build + Electron checks + gate:all + evidence gate.
#   3. Create the version bump commit ON dev and push it to origin/dev.
#   4. Fast-forward push that exact SHA to origin/main (no force, no divergence).
#   5. Tag v<version> on that SHA, push the tag, create the GitHub Release stub.
#   6. Print the exact dispatch command for publish.yml (dispatch-only workflow;
#      nothing publishes automatically on push).
#
# Usage:
#   ./promote-to-main.sh              → patch bump
#   ./promote-to-main.sh minor        → minor bump
#   ./promote-to-main.sh major        → major bump
#   ./promote-to-main.sh 1.8.0        → explicit version
#   --require-evidence                → fail if fresh-machine evidence is missing
#
# Desktop artifacts are built and attached by GitHub Actions after the
# GitHub Release is published.
set -euo pipefail

echo "cli-jaw promote-to-main"
echo "======================="

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
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

# ─── Branch + working tree preconditions ───────────────
# Promotion is dev → main by fast-forward. That only holds when the release
# commit is created on top of the current origin/dev, so refuse anything else.
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working tree is not clean. Commit or stash before promoting." >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "dev" ]; then
  echo "❌ Promotion must run from the dev branch; current branch is $CURRENT_BRANCH." >&2
  exit 1
fi

echo "🔄 Fetching origin..."
git fetch origin dev main --tags

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_DEV_SHA=$(git rev-parse origin/dev)
if [ "$LOCAL_SHA" != "$REMOTE_DEV_SHA" ]; then
  echo "❌ HEAD ($LOCAL_SHA) does not equal origin/dev ($REMOTE_DEV_SHA)." >&2
  echo "   Pull or push dev first so the promoted tree is exactly what reviewers saw." >&2
  exit 1
fi

# main must be an ancestor of dev or the \`git push origin <sha>:main\` below
# would not fast-forward. Detect the divergence now with a clear message.
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "❌ origin/main is not an ancestor of dev; promotion would not fast-forward." >&2
  echo "   Merge origin/main back into dev (or reconcile the divergence) first." >&2
  exit 1
fi

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
echo "📦 npm latest:   $NPM_LATEST"
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
echo "🔨 Building backend (tsc)..."
./node_modules/.bin/tsc

echo "🔨 Building frontend (vite)..."
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
echo "📦 New version: $VERSION"

# Desktop artifacts are named from the version COMMITTED in
# electron/package.json, and desktop-release.yml builds from a tag checkout --
# so this has to happen here, before the release commit, not at build time.
echo "🖥️  Syncing Electron version to $VERSION..."
node scripts/sync-electron-version.cjs

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

# ─── Release gates ─────────────────────────────────────
echo "🛡️  Running release gates (gate:all)..."
npm run gate:all

if [ "$REQUIRE_EVIDENCE" = true ]; then
  node scripts/require-release-evidence.mjs
else
  node scripts/require-release-evidence.mjs || echo "⚠️  Evidence gate skipped (pass --require-evidence to enforce)"
fi

# ─── Commit on dev + fast-forward promote to main ──────
echo "📝 Creating release commit on dev..."
git add package.json package-lock.json electron/package.json electron/package-lock.json
git commit -m "[agent] chore: release v$VERSION" --allow-empty

RELEASE_SHA=$(git rev-parse HEAD)
echo "📌 Release SHA: $RELEASE_SHA"

echo "⬆️  Pushing release commit to origin/dev..."
git push origin HEAD:dev

# Fast-forward main to the exact promoted SHA. No force: if this fails, main
# moved outside the dev flow and a human must look before anything publishes.
echo "⬆️  Fast-forwarding origin/main to $RELEASE_SHA..."
git push origin "$RELEASE_SHA:main"

echo "🏷️  Creating git tag v$VERSION on $RELEASE_SHA..."
git tag "v$VERSION" "$RELEASE_SHA"
git push origin "v$VERSION"

# ─── GitHub Release with changelog ─────────────────────
# IMPORTANT: create/update the GitHub Release stub before the publish workflow.
# npm publishing is handled by .github/workflows/publish.yml, dispatched
# manually below through GitHub OIDC Trusted Publishing. Keeping the release
# record in GitHub first makes the release visible and gives desktop-release.yml
# a stable release target for artifact uploads.
echo "📰 Creating GitHub Release..."
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

# ─── npm publish (manual dispatch) ─────────────────────
echo ""
echo "🚀 npm publish is dispatch-only. Review the promotion, then run:"
echo ""
echo "   gh workflow run publish.yml --ref main \\"
echo "     -f expected-sha=$RELEASE_SHA \\"
echo "     -f version=$VERSION \\"
echo "     -f tag=latest \\"
echo "     -f dry-run=false \\"
echo "     -f create-github-release=false"
echo ""
echo "   Workflow: https://github.com/lidge-jun/cli-jaw/actions/workflows/publish.yml"
echo ""
echo "✅ cli-jaw@$VERSION promoted (dev → main fast-forward, SHA $RELEASE_SHA)."
echo "   Install after publish: npm install -g cli-jaw"
if [ "$RELEASE_CREATED" = true ]; then
    echo "   Release: https://github.com/lidge-jun/cli-jaw/releases/tag/v$VERSION"
else
    echo "   ⚠️  GitHub Release for v$VERSION was NOT created — backfill it manually."
fi
