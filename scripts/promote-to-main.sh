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

REMOTE_URL="$(git remote get-url origin)"
PROMOTION_TMP_ROOT="$(promotion_tmp_root)"
WORKTREE="$(mktemp -d "$PROMOTION_TMP_ROOT/cli-jaw-promote.XXXXXX")"
PROMOTION_BRANCH="codex/promote-${STABLE_VERSION}-${PREVIEW_SHA:0:12}"
# Guards for the remote-branch cleanup below. PROMOTION_BRANCH_PUSHED is proof
# that THIS run created the remote ref: a re-run computes the same branch name
# from the same version and preview SHA, so deleting by name alone could destroy
# a branch another promotion is still using. PROMOTION_PR_MERGED hands the
# success path back to the repo's delete_branch_on_merge setting.
PROMOTION_BRANCH_PUSHED=0
PROMOTION_PR_MERGED=0
cleanup() {
  local status=$?
  if ! cleanup_promotion_checkout "$WORKTREE"; then
    echo "WARNING: failed to clean promotion checkout: $WORKTREE" >&2
  fi
  # Anything that aborts between the push and the merge would otherwise leave
  # the promotion branch on origin forever; that is how codex/promote-2.3.0,
  # -2.4.0, -2.4.1, -2.4.2 and -2.17.3-6f9165a680d5 accumulated. Delete first
  # and classify afterwards, so a probe that cannot reach origin warns loudly
  # instead of silently deciding the branch was already gone.
  if [ "$PROMOTION_BRANCH_PUSHED" -eq 1 ] && [ "$PROMOTION_PR_MERGED" -eq 0 ]; then
    if git push origin --delete "$PROMOTION_BRANCH" >/dev/null 2>&1; then
      echo "cleaned up remote promotion branch after unfinished promotion: $PROMOTION_BRANCH"
    elif ! git ls-remote --exit-code --heads origin "$PROMOTION_BRANCH" >/dev/null 2>&1; then
      echo "remote promotion branch already absent: $PROMOTION_BRANCH"
    else
      echo "WARNING: failed to delete remote promotion branch: $PROMOTION_BRANCH (delete it manually)" >&2
    fi
  fi
  # The trap runs on every exit, including the failure it is cleaning up after.
  # Re-raise the original status so cleanup never rewrites the script's result.
  exit "$status"
}
trap cleanup EXIT
prepare_promotion_checkout "$REMOTE_URL" "$PREVIEW_SHA" "$PROMOTION_BRANCH" "$WORKTREE"

(
  cd "$WORKTREE"
  npm ci --ignore-scripts
  npm version "$STABLE_VERSION" --no-git-tag-version --allow-same-version
  node scripts/sync-electron-version.cjs
  npm run gate:all
  node scripts/require-release-evidence.mjs --accept-ci-evidence
  git add package.json package-lock.json electron/package.json electron/package-lock.json
  git commit -m "chore: promote v$STABLE_VERSION"
  assert_promotion_checkout_ready_to_push "$WORKTREE" "$PREVIEW_SHA" "$PROMOTION_BRANCH"
  git push --set-upstream origin "$PROMOTION_BRANCH"
)
# A flag set inside the subshell cannot reach the trap, so it is set here. That
# is equivalent to "immediately after the push" only while the push stays the
# LAST command in the block above; keep it last (pinned by the contract test).
PROMOTION_BRANCH_PUSHED=1

PROMOTION_COMMIT="$(git -C "$WORKTREE" rev-parse HEAD)"
PR_URL="$(gh pr create \
  --base main \
  --head "$PROMOTION_BRANCH" \
  --title "chore: promote v$STABLE_VERSION" \
  --body "Promotes certified preview $PREVIEW_VERSION at $PREVIEW_SHA. Tests: $TESTS_URL")"

# GitHub materializes required checks on a fresh PR asynchronously; when
# `--watch` lands in that window it exits immediately with "no checks
# reported" and the whole promotion dies (observed: PR #386, killed seconds
# after creation while its checks were still queueing). Retry the watch while
# that specific startup condition holds; real check failures still fail fast.
CHECKS_DEADLINE=$((SECONDS + 300))
while true; do
  CHECKS_STATUS=0
  CHECKS_OUTPUT="$(gh pr checks "$PR_URL" --required --watch --fail-fast 2>&1)" || CHECKS_STATUS=$?
  printf '%s\n' "$CHECKS_OUTPUT"
  [ "$CHECKS_STATUS" -eq 0 ] && break
  if printf '%s' "$CHECKS_OUTPUT" | grep -qi 'no checks reported' \
    && [ "$SECONDS" -lt "$CHECKS_DEADLINE" ]; then
    sleep 15
    continue
  fi
  exit "$CHECKS_STATUS"
done
gh pr merge "$PR_URL" --squash --match-head-commit "$PROMOTION_COMMIT"
# From here the branch belongs to GitHub's delete_branch_on_merge. Racing that
# auto-delete only produces confusing errors, and a later verification failure
# is not a reason to remove a branch whose merge already landed.
PROMOTION_PR_MERGED=1

MERGED_AT="$(gh pr view "$PR_URL" --json mergedAt --jq '.mergedAt // ""')"
if [ -z "$MERGED_AT" ]; then
  echo "ERROR: promotion PR did not merge" >&2
  exit 1
fi
PR_MERGE_SHA="$(gh pr view "$PR_URL" --json mergeCommit --jq '.mergeCommit.oid // ""')"
if [ -z "$PR_MERGE_SHA" ]; then
  echo "ERROR: promotion PR has no merge commit SHA" >&2
  exit 1
fi

git fetch origin main
MERGED_MAIN_SHA="$(git rev-parse 'refs/remotes/origin/main^{commit}')"
LIVE_MAIN_SHA="$(git ls-remote origin refs/heads/main | cut -f1)"
if [ -z "$LIVE_MAIN_SHA" ] || [ "$MERGED_MAIN_SHA" != "$LIVE_MAIN_SHA" ] \
  || [ "$MERGED_MAIN_SHA" != "$PR_MERGE_SHA" ]; then
  echo "ERROR: merged PR SHA, origin/main, and live main head do not match" >&2
  exit 1
fi
MERGED_VERSION="$(git show "$MERGED_MAIN_SHA:package.json" \
  | node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0,"utf8")).version)')"
if [ "$MERGED_VERSION" != "$STABLE_VERSION" ]; then
  echo "ERROR: merged main version is $MERGED_VERSION, expected $STABLE_VERSION" >&2
  exit 1
fi

deadline=$((SECONDS + 1200))
MAIN_TESTS_URL=""
while [ "$SECONDS" -lt "$deadline" ]; do
  MAIN_TESTS_URL="$(gh run list \
    --workflow test.yml \
    --branch main \
    --commit "$MERGED_MAIN_SHA" \
    --event push \
    --status success \
    --limit 1 --json url --jq '.[0].url // ""')"
  [ -n "$MAIN_TESTS_URL" ] && break
  failed="$(gh run list \
    --workflow test.yml \
    --branch main \
    --commit "$MERGED_MAIN_SHA" \
    --event push \
    --status completed \
    --limit 1 --json conclusion --jq '.[0].conclusion // ""')"
  case "$failed" in
    failure|cancelled|timed_out|startup_failure|action_required)
      echo "ERROR: main Tests completed with $failed" >&2
      exit 1
      ;;
  esac
  sleep 10
done
if [ -z "$MAIN_TESTS_URL" ]; then
  echo "ERROR: timed out waiting for successful main Tests" >&2
  exit 1
fi

deadline=$((SECONDS + 1200))
MAIN_PLATFORM_URL=""
while [ "$SECONDS" -lt "$deadline" ]; do
  MAIN_PLATFORM_URL="$(gh run list \
    --workflow postinstall-platform.yml \
    --branch main \
    --commit "$MERGED_MAIN_SHA" \
    --event push \
    --status success \
    --limit 1 --json url --jq '.[0].url // ""')"
  [ -n "$MAIN_PLATFORM_URL" ] && break
  failed="$(gh run list \
    --workflow postinstall-platform.yml \
    --branch main \
    --commit "$MERGED_MAIN_SHA" \
    --event push \
    --status completed \
    --limit 1 --json conclusion --jq '.[0].conclusion // ""')"
  case "$failed" in
    failure|cancelled|timed_out|startup_failure|action_required)
      echo "ERROR: main Postinstall Platform Checks completed with $failed" >&2
      exit 1
      ;;
  esac
  sleep 10
done
if [ -z "$MAIN_PLATFORM_URL" ]; then
  echo "ERROR: timed out waiting for successful main Postinstall Platform Checks" >&2
  exit 1
fi

LIVE_MAIN_SHA="$(git ls-remote origin refs/heads/main | cut -f1)"
if [ "$LIVE_MAIN_SHA" != "$MERGED_MAIN_SHA" ]; then
  echo "ERROR: origin/main moved while waiting for release CI" >&2
  exit 1
fi

gh workflow run publish.yml \
  --ref main \
  -f version="$STABLE_VERSION" \
  -f tag=latest \
  -f expected-sha="$MERGED_MAIN_SHA" \
  -f dry-run=false \
  -f create-github-release=true

echo "stable publish dispatched: cli-jaw@$STABLE_VERSION from $MERGED_MAIN_SHA"
