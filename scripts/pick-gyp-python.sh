#!/usr/bin/env bash
# Print a python3 that node-gyp can actually run under.
#
# node-gyp's bundled gyp still does `from distutils.version import StrictVersion`,
# and distutils was removed in Python 3.12. On a machine whose default python3 is
# Homebrew 3.12+ the native rebuild dies with:
#
#   ModuleNotFoundError: No module named 'distutils'
#   ⨯ node-gyp failed to rebuild '.../node_modules/node-pty'
#
# Observed on macOS 27 with Homebrew Python 3.14.6 while building the desktop app
# on a second machine. macOS still ships /usr/bin/python3 (3.9.6), which has
# distutils, so a working interpreter is usually present -- it just is not the
# one on PATH.
#
# CI already knew: .github/workflows/desktop-release.yml pins actions/setup-python
# to 3.11 with exactly this reasoning in a comment. The local build path never got
# the same treatment, so `npm run electron:dist:mac` on a developer machine was the
# one route into node-gyp with no defense.
#
# Candidates are TESTED, not assumed: a hardcoded path is the same bet that broke
# here, one Python release later. An explicit $PYTHON still wins, because the
# caller may know something this script does not.
set -euo pipefail

has_distutils() {
  [ -x "$1" ] || return 1
  "$1" -c 'import distutils' >/dev/null 2>&1
}

if [ -n "${PYTHON:-}" ]; then
  printf '%s\n' "$PYTHON"
  exit 0
fi

for candidate in \
  /usr/bin/python3 \
  "$(command -v python3.11 2>/dev/null || true)" \
  "$(command -v python3.10 2>/dev/null || true)" \
  "$(command -v python3.9 2>/dev/null || true)" \
  "$(command -v python3 2>/dev/null || true)"
do
  [ -n "$candidate" ] || continue
  if has_distutils "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

# Nothing usable. Fall back to whatever python3 exists so the caller fails with
# node-gyp's own message rather than an empty variable, and say why.
fallback="$(command -v python3 2>/dev/null || true)"
if [ -n "$fallback" ]; then
  echo "[gyp-python] no python3 with distutils found; falling back to $fallback" >&2
  echo "[gyp-python] node-gyp will likely fail. Install python@3.11 or set PYTHON=<path>." >&2
  printf '%s\n' "$fallback"
  exit 0
fi

echo "[gyp-python] no python3 on PATH at all" >&2
exit 1
