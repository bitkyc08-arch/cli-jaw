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
# reported" / "no required checks reported" and the whole promotion dies
# (observed: PRs #386-#388, killed while checks were queueing). The required
# context here is ci-aggregate, which is REPORTED ONLY AFTER node-tests
# finishes (~7-8 min), so the deadline must comfortably exceed a full test.yml
# run, not just the registration lag. Retry the watch while that startup
# condition holds; real check failures still fail fast.
CHECKS_DEADLINE=$((SECONDS + 1800))
while true; do
  CHECKS_STATUS=0
  CHECKS_OUTPUT="$(gh pr checks "$PR_URL" --required --watch --fail-fast 2>&1)" || CHECKS_STATUS=$?
  printf '%s\n' "$CHECKS_OUTPUT"
  [ "$CHECKS_STATUS" -eq 0 ] && break
  if printf '%s' "$CHECKS_OUTPUT" | grep -qiE 'no (required )?checks reported' \
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

# ─── Tree-identity fast path (260819 release-speed) ─────────────────────────
# A squash merge onto an unmoved main produces a commit whose TREE equals the
# promotion PR head's tree — the exact tree the PR's required checks already
# certified (branch protection accepts PR-head evidence; strict=false). When
# the trees match, the main push CI re-run carries no new information, so the
# release does not wait for it. When they differ (main advanced between PR
# creation and merge, so the squash re-applied onto a new base), that is a
# tree nobody tested: fail closed into the original wait loops.
git fetch origin "+refs/pull/*/head:refs/remotes/origin/pr/*" 2>/dev/null || true
MERGED_TREE="$(git rev-parse "$MERGED_MAIN_SHA^{tree}")"
CERTIFIED_TREE="$(git rev-parse "$PROMOTION_COMMIT^{tree}" 2>/dev/null || echo "")"
CERTIFIED_SHA=""
if [ -n "$CERTIFIED_TREE" ] && [ "$MERGED_TREE" = "$CERTIFIED_TREE" ]; then
  CERTIFIED_SHA="$PROMOTION_COMMIT"
  echo "tree-identity: merge $MERGED_MAIN_SHA tree matches certified PR head $PROMOTION_COMMIT; skipping the main CI wait"
else
  echo "tree-identity: MISMATCH (main advanced during promotion?) — falling back to the main CI wait"
  wait_for_main_run() {
    local workflow="$1" label="$2" url="" failed=""
    local deadline=$((SECONDS + 1200))
    while [ "$SECONDS" -lt "$deadline" ]; do
      url="$(gh run list \
        --workflow "$workflow" \
        --branch main \
        --commit "$MERGED_MAIN_SHA" \
        --event push \
        --status success \
        --limit 1 --json url --jq '.[0].url // ""')"
      [ -n "$url" ] && { echo "$label certified by: $url" >&2; return 0; }
      failed="$(gh run list \
        --workflow "$workflow" \
        --branch main \
        --commit "$MERGED_MAIN_SHA" \
        --event push \
        --status completed \
        --limit 1 --json conclusion --jq '.[0].conclusion // ""')"
      case "$failed" in
        failure|cancelled|timed_out|startup_failure|action_required)
          echo "ERROR: main $label completed with $failed" >&2
          return 1
          ;;
      esac
      sleep 10
    done
    echo "ERROR: timed out waiting for successful main $label" >&2
    return 1
  }
  wait_for_main_run test.yml "Tests"
  wait_for_main_run postinstall-platform.yml "Postinstall Platform Checks"
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
  ${CERTIFIED_SHA:+-f certified-sha="$CERTIFIED_SHA"} \
  -f dry-run=false \
  -f create-github-release=true

echo "stable publish dispatched: cli-jaw@$STABLE_VERSION from $MERGED_MAIN_SHA"

# ─── Realign dev/preview onto the new main (#466) ───────────────────────────
# The squash above folds preview's commits into one NEW commit, so main stops
# being an ancestor of preview the instant this script succeeds — and the guard
# at the top of this same script requires exactly that ancestry on the next
# cycle. Left to prose in AGENTS.md, that realignment gets skipped, and the
# manual recovery it forces is what silently dropped #418's code from the
# published 2.17.13 tarball.
#
# realign_branch_onto_main lives in promotion-checkout.sh and builds the commit
# from plumbing, so the published tree is an input rather than a merge result.
# A failure here is a warning, not a release failure: the publish above already
# went out, and the only cost is that the NEXT promotion needs a manual repair
# (AGENTS.md carries that recipe).
realign_branch_onto_main preview "$MERGED_MAIN_SHA" \
  "chore: record the v$STABLE_VERSION promotion as an ancestor" \
  || echo "WARN: preview realignment failed; the next promotion will need a manual realign" >&2
realign_branch_onto_main dev "$MERGED_MAIN_SHA" \
  "chore: record the v$STABLE_VERSION promotion as an ancestor" \
  || echo "WARN: dev realignment failed; realign it before the next release" >&2

POST_PREVIEW="$(git ls-remote origin refs/heads/preview | cut -f1)"
if [ -n "$POST_PREVIEW" ] && ! git merge-base --is-ancestor "$MERGED_MAIN_SHA" "$POST_PREVIEW"; then
  echo "WARN: origin/main is still not an ancestor of origin/preview — the next promotion will be blocked" >&2
fi
