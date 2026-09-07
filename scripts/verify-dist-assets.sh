#!/bin/bash
# Verify that every non-TS asset the COMPILED output still imports actually
# exists in dist/. Source-level scanning cannot do this job: it misses paths
# assembled at runtime, and it drifts from what tsc actually emitted. The
# build artifact is the only honest subject.
#
# Scope note (deliberate, not an oversight): this only inspects SINGLE-LINE
# literal dynamic imports of .mjs files. It does NOT see template-literal
# specifiers, multi-line import calls, or runtime-assembled paths — the
# Defuddle vendor bundle and the prompt templates are covered by explicit copy
# steps in atomic-build.sh instead. A partial checker that pretends to be
# complete is worse than one that states its limit.
#
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
    echo "[verify-dist-assets] dist/ not found — run npm run build first" >&2
    exit 1
fi

missing=0
while IFS= read -r js; do
    while IFS= read -r spec; do
        [ -z "$spec" ] && continue
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
