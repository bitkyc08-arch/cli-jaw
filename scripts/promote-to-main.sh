#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
# shellcheck source=scripts/promotion-checkout.sh
source "$SCRIPT_DIR/promotion-checkout.sh"

command -v gh >/dev/null 2>&1 || { echo "ERROR: gh is required" >&2; exit 1; }
gh auth status >/dev/null
git fetch origin main preview --tags --prune

LIVE_PREVIEW_SHA="$(git rev-parse 'refs/remotes/origin/preview^{commit}')"
PREVIEW_SHA="$(git rev-parse "${1:-$LIVE_PREVIEW_SHA}^{commit}")"
if [ "$PREVIEW_SHA" != "$LIVE_PREVIEW_SHA" ]; then
  echo "ERROR: requested SHA is not the live origin/preview head" >&2
  exit 1
fi

PREVIEW_VERSION="$(git show "$PREVIEW_SHA:package.json" \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).version)')"
if [[ ! "$PREVIEW_VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-preview\.[0-9]+$ ]]; then
  echo "ERROR: preview version must match X.Y.Z-preview.TIMESTAMP; got $PREVIEW_VERSION" >&2
  exit 1
fi
STABLE_VERSION="${BASH_REMATCH[1]}"

TESTS_URL="$(gh run list \
  --workflow test.yml \
  --branch preview \
  --commit "$PREVIEW_SHA" \
  --event push \
  --status success \
  --limit 1 --json url --jq '.[0].url // ""')"
if [ -z "$TESTS_URL" ]; then
  echo "ERROR: no successful Tests run for $PREVIEW_SHA on preview" >&2
  exit 1
fi

MAIN_SHA="$(git rev-parse 'refs/remotes/origin/main^{commit}')"
if ! git merge-base --is-ancestor "$MAIN_SHA" "$PREVIEW_SHA"; then
  echo "ERROR: origin/main is not an ancestor of the certified preview SHA" >&2
  exit 1
fi

# ─── Build the stable version bump ON TOP OF preview (#480) ─────────────────
# The bump commit used to be minted on a side branch and squashed onto main,
# which folded preview's history into one NEW commit. main then stopped being
# an ancestor of preview the instant the promotion succeeded, and the guard
# above demanded that ancestry back on the next cycle: the script broke its own
# precondition every release, and #468 had to bolt a realignment onto the end.
#
# Extending preview instead makes the whole chain fast-forwardable. main never
# gains a commit preview does not have, so there is nothing to realign, and the
# SHA that npm publishes is the SHA CI certified rather than a same-tree copy.
REMOTE_URL="$(git remote get-url origin)"
PROMOTION_TMP_ROOT="$(promotion_tmp_root)"
WORKTREE="$(mktemp -d "$PROMOTION_TMP_ROOT/cli-jaw-promote.XXXXXX")"
cleanup() {
  local status=$?
  if ! cleanup_promotion_checkout "$WORKTREE"; then
    echo "WARNING: failed to clean promotion checkout: $WORKTREE" >&2
  fi
  # The trap runs on every exit, including the failure it is cleaning up after.
  # Re-raise the original status so cleanup never rewrites the script's result.
  exit "$status"
}
trap cleanup EXIT
prepare_promotion_checkout "$REMOTE_URL" "$PREVIEW_SHA" preview "$WORKTREE"

(
  cd "$WORKTREE"
  npm ci --ignore-scripts
  npm version "$STABLE_VERSION" --no-git-tag-version --allow-same-version
  node scripts/sync-electron-version.cjs
  npm run gate:all
  node scripts/require-release-evidence.mjs --accept-ci-evidence
  git add package.json package-lock.json electron/package.json electron/package-lock.json
  git commit -m "chore: promote v$STABLE_VERSION"
  assert_promotion_checkout_ready_to_push "$WORKTREE" "$PREVIEW_SHA" preview
)
PROMOTION_COMMIT="$(git -C "$WORKTREE" rev-parse HEAD)"

# Fast-forward preview first. preview is where the release CI that publish.yml
# gates on actually runs, so the bump has to be certified there before main can
# take it. --force-with-lease pins the push to the SHA this run certified: if
# preview moved while the gates ran, the push is refused instead of silently
# discarding whatever landed.
git push --force-with-lease="refs/heads/preview:$PREVIEW_SHA" \
  origin "$PROMOTION_COMMIT:refs/heads/preview"
echo "preview fast-forwarded to the promotion commit: $PROMOTION_COMMIT"

wait_for_run() {
  local workflow="$1" label="$2" branch="$3" sha="$4" url="" failed=""
  local deadline=$((SECONDS + 1200))
  while [ "$SECONDS" -lt "$deadline" ]; do
    url="$(gh run list \
      --workflow "$workflow" \
      --branch "$branch" \
      --commit "$sha" \
      --event push \
      --status success \
      --limit 1 --json url --jq '.[0].url // ""')"
    [ -n "$url" ] && { echo "$label certified by: $url" >&2; return 0; }
    failed="$(gh run list \
      --workflow "$workflow" \
      --branch "$branch" \
      --commit "$sha" \
      --event push \
      --status completed \
      --limit 1 --json conclusion --jq '.[0].conclusion // ""')"
    case "$failed" in
      failure|cancelled|timed_out|startup_failure|action_required)
        echo "ERROR: $branch $label completed with $failed" >&2
        return 1
        ;;
    esac
    sleep 10
  done
  echo "ERROR: timed out waiting for successful $branch $label" >&2
  return 1
}

# postinstall-platform.yml carries paths: filters, so it never runs for a SHA
# that touches no installer-sensitive path. Waiting unconditionally would burn
# the full deadline on a run that will never exist, so the wait is gated on the
# same detector publish.yml uses.
PLATFORM_REQUIRED=false
PREVIOUS_TAG="$(git -C "$WORKTREE" tag --merged "$PROMOTION_COMMIT" --sort=-v:refname \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
if [ -n "$PREVIOUS_TAG" ]; then
  DETECTOR_STATUS=0
  git -C "$WORKTREE" diff --name-only "$PREVIOUS_TAG..$PROMOTION_COMMIT" \
    | node scripts/require-release-evidence.mjs --changed-files-stdin || DETECTOR_STATUS=$?
  [ "$DETECTOR_STATUS" -eq 1 ] && PLATFORM_REQUIRED=true
fi

wait_for_run test.yml "Tests" preview "$PROMOTION_COMMIT"
if [ "$PLATFORM_REQUIRED" = true ]; then
  wait_for_run postinstall-platform.yml "Postinstall Platform Checks" preview "$PROMOTION_COMMIT"
fi

# ─── Fast-forward main onto the certified commit ────────────────────────────
# No PR, no squash: main takes the exact SHA preview just certified. A plain
# push refuses anything that is not a fast-forward, so main can never gain a
# commit preview lacks, and the ancestry guard at the top of this script stays
# true for the next cycle without any repair step.
LIVE_PREVIEW_AFTER="$(git ls-remote origin refs/heads/preview | cut -f1)"
if [ "$LIVE_PREVIEW_AFTER" != "$PROMOTION_COMMIT" ]; then
  echo "ERROR: origin/preview moved while waiting for release CI" >&2
  exit 1
fi
git push origin "$PROMOTION_COMMIT:refs/heads/main"

git fetch origin main
MERGED_MAIN_SHA="$(git ls-remote origin refs/heads/main | cut -f1)"
if [ "$MERGED_MAIN_SHA" != "$PROMOTION_COMMIT" ]; then
  echo "ERROR: origin/main is $MERGED_MAIN_SHA, expected the certified $PROMOTION_COMMIT" >&2
  exit 1
fi
MERGED_VERSION="$(git show "$MERGED_MAIN_SHA:package.json" \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).version)')"
if [ "$MERGED_VERSION" != "$STABLE_VERSION" ]; then
  echo "ERROR: merged main version is $MERGED_VERSION, expected $STABLE_VERSION" >&2
  exit 1
fi

# main and preview are now the same commit, so the preview push runs waited on
# above certify main too. publish.yml resolves them by SHA, not by branch, which
# is why the certified-sha tree-identity workaround is gone.
gh workflow run publish.yml \
  --ref main \
  -f version="$STABLE_VERSION" \
  -f tag=latest \
  -f expected-sha="$MERGED_MAIN_SHA" \
  -f dry-run=false \
  -f create-github-release=true

echo "stable publish dispatched: cli-jaw@$STABLE_VERSION from $MERGED_MAIN_SHA"

# Keep dev on the released line. dev is where work continues, so if it does not
# carry the bump the next release-preview.sh cuts from a branch that is behind
# main, and the ancestry guard above fails on the following cycle.
DEV_SHA="$(git ls-remote origin refs/heads/dev | cut -f1)"
if [ -n "$DEV_SHA" ] && git merge-base --is-ancestor "$DEV_SHA" "$PROMOTION_COMMIT"; then
  if git push origin "$PROMOTION_COMMIT:refs/heads/dev" 2>/dev/null; then
    echo "dev fast-forwarded onto the release: $PROMOTION_COMMIT"
  else
    echo "WARN: could not fast-forward dev; merge origin/main into dev by hand" >&2
  fi
else
  echo "NOTE: dev has advanced past the release; merge origin/main into dev to keep it fast-forwardable" >&2
fi
