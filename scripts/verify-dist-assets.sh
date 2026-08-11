#!/bin/bash
# Verify that every non-TS asset the COMPILED output still imports actually
# exists in dist/. Source-level scanning cannot do this job: it misses paths
# assembled at runtime, and it drifts from what tsc actually emitted. The
# build artifact is the only honest subject.
#
# Scope note (deliberate, not an oversight): this only inspects literal
# dynamic imports of .mjs files. Runtime-assembled paths — the Defuddle vendor
# bundle and the prompt templates — are covered by explicit copy steps in
# atomic-build.sh instead. A partial checker that pretends to be complete is
# worse than one that states its limit.
#
# Regression guarded: #275, where bun-shim.mjs was copied only when a
# generated, gitignored bundle happened to exist locally.
set -uo pipefail
cd "$(dirname "$0")/.."

# The jawcode bundles are produced by a separate Bun build and are gitignored,
# so a plain `npm run build` legitimately omits them. bun-shim.mjs is NOT in
# this list — that omission is the bug this script exists to catch.
OPTIONAL='jawcode-tui-bundle\.mjs|jawcode-interactive-bundle\.mjs'

if [ ! -d dist ]; then
    echo "[verify-dist-assets] dist/ not found — run npm run build first" >&2
    exit 1
fi

missing=0
while IFS= read -r js; do
    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
        [[ "$spec" =~ $OPTIONAL ]] && continue
        target="$(dirname "$js")/$spec"
        if [ ! -f "$target" ]; then
            echo "missing: $spec (imported from ${js#dist/})" >&2
            missing=$((missing + 1))
        fi
    done < <(grep -oE "import\((['\"])[^'\"]+\.mjs\1\)" "$js" \
             | sed -E "s/^import\(['\"]//; s/['\"]\)$//")
done < <(find dist -name '*.js')

if [ "$missing" -ne 0 ]; then
    echo "[verify-dist-assets] $missing missing asset(s)" >&2
    # Saturate: shell exit status wraps at 256, so `exit $missing` could report
    # success for exactly 256 failures. A gate must never turn red into green.
    exit 1
fi

echo "[verify-dist-assets] ok"
exit 0
