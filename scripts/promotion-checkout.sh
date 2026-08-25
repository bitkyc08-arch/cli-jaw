#!/usr/bin/env bash

promotion_error() {
  echo "ERROR: $*" >&2
}

promotion_tmp_root() {
  local root="${CLI_JAW_PROMOTION_TMP_ROOT:-${TMPDIR:-/tmp}}"
  if [ ! -d "$root" ]; then
    promotion_error "promotion temp root does not exist: $root"
    return 1
  fi
  (cd "$root" && pwd -P)
}

promotion_checkout_path_safe() {
  local checkout_dir="${1:-}"
  local root parent base
  if [ -z "$checkout_dir" ]; then
    promotion_error "promotion checkout path is empty"
    return 1
  fi
  if [ -L "$checkout_dir" ]; then
    promotion_error "refusing symlink promotion checkout path: $checkout_dir"
    return 1
  fi
  root="$(promotion_tmp_root)" || return 1
  parent="$(cd "$(dirname "$checkout_dir")" 2>/dev/null && pwd -P)" || {
    promotion_error "promotion checkout parent is not accessible: $checkout_dir"
    return 1
  }
  base="$(basename "$checkout_dir")"
  if [ "$parent" != "$root" ] || [[ "$base" != cli-jaw-promote.* ]]; then
    promotion_error "refusing unsafe promotion checkout path: $checkout_dir"
    return 1
  fi
}

cleanup_promotion_checkout() {
  local checkout_dir="${1:-}"
  promotion_checkout_path_safe "$checkout_dir" || return 1
  [ -e "$checkout_dir" ] || return 0
  rm -rf -- "$checkout_dir"
}

assert_promotion_checkout_initial() {
  local checkout_dir="$1"
  local preview_sha="$2"
  local expected_root actual_root actual_head checkout_status
  promotion_checkout_path_safe "$checkout_dir" || return 1
  expected_root="$(cd "$checkout_dir" && pwd -P)" || return 1
  actual_root="$(git -C "$checkout_dir" rev-parse --show-toplevel 2>/dev/null)" || {
    promotion_error "promotion checkout is not a Git work tree: $checkout_dir"
    return 1
  }
  actual_root="$(cd "$actual_root" && pwd -P)" || return 1
  if [ "$actual_root" != "$expected_root" ]; then
    promotion_error "promotion checkout root mismatch: expected $expected_root, got $actual_root"
    return 1
  fi
  actual_head="$(git -C "$checkout_dir" rev-parse HEAD)"
  if [ "$actual_head" != "$preview_sha" ]; then
    promotion_error "promotion checkout HEAD is $actual_head, expected $preview_sha"
    return 1
  fi
  checkout_status="$(git -C "$checkout_dir" status --porcelain --untracked-files=all)"
  if [ -n "$checkout_status" ]; then
    promotion_error "promotion checkout is dirty before mutation"
    return 1
  fi
}

prepare_promotion_checkout() {
  local remote_url="$1"
  local preview_sha="$2"
  local promotion_branch="$3"
  local checkout_dir="$4"
  local branch_probe_status
  promotion_checkout_path_safe "$checkout_dir" || return 1
  if [ ! -d "$checkout_dir" ] || [ -n "$(find "$checkout_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    promotion_error "promotion checkout directory must exist and be empty: $checkout_dir"
    return 1
  fi

  if git ls-remote --exit-code "$remote_url" "refs/heads/$promotion_branch" >/dev/null 2>&1; then
    promotion_error "remote promotion branch already exists: $promotion_branch"
    return 1
  else
    branch_probe_status=$?
    if [ "$branch_probe_status" -ne 2 ]; then
      promotion_error "could not verify remote promotion branch state: $promotion_branch"
      return "$branch_probe_status"
    fi
  fi

  git clone --quiet --no-recurse-submodules --no-checkout "$remote_url" "$checkout_dir"
  git -C "$checkout_dir" checkout --quiet -b "$promotion_branch" "$preview_sha"
  assert_promotion_checkout_initial "$checkout_dir" "$preview_sha"
}

assert_promotion_checkout_ready_to_push() {
  local checkout_dir="$1"
  local preview_sha="$2"
  local promotion_branch="$3"
  local current_branch checkout_status commit_count
  promotion_checkout_path_safe "$checkout_dir" || return 1
  current_branch="$(git -C "$checkout_dir" branch --show-current)"
  if [ "$current_branch" != "$promotion_branch" ]; then
    promotion_error "promotion checkout branch is $current_branch, expected $promotion_branch"
    return 1
  fi
  if ! git -C "$checkout_dir" merge-base --is-ancestor "$preview_sha" HEAD; then
    promotion_error "promotion branch does not descend from certified preview $preview_sha"
    return 1
  fi
  commit_count="$(git -C "$checkout_dir" rev-list --count "$preview_sha..HEAD")"
  if [ "$commit_count" -lt 1 ]; then
    promotion_error "promotion branch has no commit beyond certified preview"
    return 1
  fi
  checkout_status="$(git -C "$checkout_dir" status --porcelain --untracked-files=all)"
  if [ -n "$checkout_status" ]; then
    promotion_error "promotion checkout is dirty before push"
    return 1
  fi
  if ! git -C "$checkout_dir" diff --check "$preview_sha..HEAD"; then
    promotion_error "promotion commit contains whitespace errors"
    return 1
  fi
}

# ─── Post-promotion realignment (#466) ─────────────────────────────────────
#
# A squash promotion folds preview's commits into one NEW commit on main, so
# main stops being an ancestor of preview the moment the promotion succeeds —
# and promote-to-main.sh demands exactly that ancestry on the next cycle. The
# script breaks its own precondition every release. Leaving the repair to prose
# is what produced the 2.17.13 incident: a hand-made merge claimed to take the
# preview tree, took main's, and shipped a tarball missing #418's code.
#
# Built from plumbing (commit-tree) rather than a worktree on purpose: the tree
# is an INPUT here, not a merge result, so the published content cannot change
# no matter which side is which. The caller re-checks it anyway.
realign_branch_onto_main() {
  local branch="$1" main_sha="$2" message="$3"
  local head tree new_commit
  head="$(git ls-remote origin "refs/heads/$branch" | cut -f1)"
  if [ -z "$head" ]; then
    echo "realign: no origin/$branch to realign" >&2
    return 0
  fi
  if git merge-base --is-ancestor "$main_sha" "$head" 2>/dev/null; then
    echo "realign: $branch already has main as an ancestor"
    return 0
  fi
  git fetch origin "$branch" >/dev/null 2>&1 || true
  tree="$(git rev-parse "$head^{tree}")" || {
    promotion_error "realign: cannot read $branch tree"
    return 1
  }
  new_commit="$(git commit-tree "$tree" -p "$head" -p "$main_sha" -m "$message")" || {
    promotion_error "realign: could not create the realignment commit for $branch"
    return 1
  }
  if [ "$(git rev-parse "$new_commit^{tree}")" != "$tree" ]; then
    promotion_error "realign: $branch tree changed; refusing to push"
    return 1
  fi
  if ! git merge-base --is-ancestor "$main_sha" "$new_commit"; then
    promotion_error "realign: $main_sha is still not an ancestor of $branch; refusing to push"
    return 1
  fi
  if git push origin "$new_commit:refs/heads/$branch" >/dev/null 2>&1; then
    echo "realign: $branch now has main as an ancestor, tree unchanged"
  else
    echo "realign: could not push $branch (did it move?)" >&2
    return 1
  fi
}
