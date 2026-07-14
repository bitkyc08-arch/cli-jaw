# Dashboard2 render parity 085 closure receipt

Date: 2026-07-15 (Asia/Seoul)
Scope: W4 08x closing gate; tests and `public/dashboard2/src/dev/**` only.
Corpus provenance: **CURATED REPRESENTATIVE**, `curated-synthetic`; no real-session provenance.

## Build and static gates

Command:

```text
npm run typecheck && npm run typecheck:frontend && npm run build && npm run build:frontend && npm run check:frontend-build-output
```

Result: PASS (exit 0).

```text
typecheck: PASS
typecheck:frontend: PASS
[atomic-build] dist/ swapped successfully
build:frontend: PASS, 5069 modules transformed, built in 437ms
check:frontend-build-output: PASS
Dashboard2 bundle OK (static-shiki=0, raw=1999006, gzip=239910, largest render-shiki gzip=237228)
Web UI build output OK (1 app entries, 49191 bytes)
```

The Vite build emitted its existing non-fatal warnings for `theme-boot.js` lacking `type="module"` and chunks larger than 500 kB.

## Unit contract battery

Command: the exact 9-file unit command required by 085 section 4.

Result: PASS (exit 0).

```text
tests 70
pass 70
fail 0
duration_ms 1189.902792
```

## Browser files (run one at a time)

### `tests/browser/dashboard2-render-parity.test.ts`

Result: FAIL (exit 1), 6/7 gates passed.

```text
PASS semantic parity
PASS streaming differential
PASS D20 browser rules
PASS link preview opt-in and abort
PASS XSS rerun
FAIL teardown baseline
PASS caveat sweep
tests 7, pass 6, fail 1, duration_ms 5752.312083
```

Failure evidence:

```text
AssertionError: actual page errors = ["__name is not defined"], expected []
tests/browser/dashboard2-render-parity.test.ts:196
```

The error originates in the production widget iframe `srcdoc` bridge path at
`public/dashboard2/src/turn-stream/widgets/widget-iframe-bridge.ts:11-14` after the
Vite-transformed bridge executes in the isolated iframe. Production source was not
modified under this delegation.

### `tests/browser/dashboard2-render-embeds-links.test.ts`

Result: PASS (exit 0): 5/5, duration 3505.423208 ms.

### `tests/browser/dashboard2-tool-detail-windowing.test.ts`

Result: PASS (exit 0): 1/1, duration 1620.985333 ms.

```text
requests=6, lineCount=32, peakResidentServed=262144
p95=9ms, max=10.3ms, over100=0
```

### `tests/browser/dashboard2-turn-stream-budget.test.ts`

Result: PASS (exit 0): 7/7, duration 66873.724083 ms.

```text
frames: samples=7199, p95Ms=9.900000000000546, maxMs=17
anchor: perStepMaxPx=0, cumulativeDriftPx=0
heap growth=945636, cap=16777216
listenerDelta=0, documentDelta=0
```

## Line-count gate

Command: `bash structure/verify-counts.sh`

Result: FAIL (exit 2), reported only and not fixed.

```text
file tree entries: 328 matched, 2 paths skipped
public/ total: documented ~116199L, actual 116734L
public/ files: documented 732, actual 743
matched 377, mismatched 2, fixed 0
```

## Closure disposition

08x closure is **FAIL/BLOCKED BY PRODUCTION GAP** because the teardown console-error
gate fails. The corpus, semantic/streaming/D20/link/XSS gates, build/static gates,
unit contracts, adjacent browser suites, and performance budget pass. The independent
line-count documentation gate also remains red and was intentionally not auto-fixed.
