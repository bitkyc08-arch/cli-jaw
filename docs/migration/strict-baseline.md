# strict-migration baseline

> Frozen 2026-05-05 from `devlog/_plan/strict-migration/00-diagnostic.md` (post-WIP HEAD `3e4f218`).
> AST-aware counts via `scripts/check-strict-baseline.mjs`.
>
> When a phase intentionally lowers a counter, update this file in the same PR.
>
> Two markers are recognised by the scanner:
> - `// @strict-debt(P##)` — temporary debt; must be cleared by the named phase.
> - `// @strict-allow-any(<reason>)` — permanent contract; allowed indefinitely.
>
> An unmarked `any` counts toward the `any` column. Markers shift the count to `debt` or `allow`.

## any-shapes baseline

| dir | any | debt | allow |
|-----|----:|-----:|------:|
| src | 175 | 0 | 0 |
| bin | 0 | 0 | 0 |
| lib | 42 | 0 | 0 |
| public/manager/src | 0 | 0 | 0 |
| types | 0 | 0 | 0 |

## Notes

- `tests/` is excluded from this baseline (D-H deferral).
- `tsconfig.frontend.json` flag flips are deferred to P19; counts however are tracked.
- The script counts `.ts` and `.tsx` only. `.d.ts` are included.
- If a column drops after a phase, lower it in the same PR; never leave stale numbers.
