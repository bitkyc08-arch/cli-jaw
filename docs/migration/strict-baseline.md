# strict-migration baseline

> Frozen 2026-05-05 from `devlog/_plan/strict-migration/00-diagnostic.md` (post-WIP HEAD `3e4f218`).
> Lowered 2026-05-05 at P20 on HEAD `5990f3f9667ee995eee73ea54725fbfaf4923da7`.
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
| src | 99 | 0 | 0 |
| bin | 0 | 0 | 0 |
| lib | 0 | 0 | 0 |
| public/js | 0 | 0 | 0 |
| public/manager/src | 0 | 0 | 0 |
| scripts | 0 | 0 | 0 |
| server.ts | 0 | 0 | 0 |
| types | 0 | 0 | 0 |

## Notes

- `tests/` is excluded from this baseline (D-H deferral).
- `tsconfig.frontend.json` flag flips are deferred to P19; counts however are tracked.
- P19 completed on ManagerCheckpoint `5990f3f9667ee995eee73ea54725fbfaf4923da7`; frontend flags now match the backend strict floor.
- P20 D-G target is option (c): `<100 any outside tests`, with `bin/`, `lib/`, `public/js/`, `public/manager/src/`, `scripts/`, `server.ts`, and `types/` fixed at 0.
- Post-P20 `@strict-debt` markers are forbidden; the gate fails on marker reintroduction across `src/`, `bin/`, `lib/`, `scripts/`, `server.ts`, `public/`, and `types/`.
- The script counts `.ts` and `.tsx` only. `.d.ts` are included.
- If a column drops after a phase, lower it in the same PR; never leave stale numbers.
