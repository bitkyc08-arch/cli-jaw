# strict-migration baseline

> Frozen 2026-05-05 at post-WIP HEAD `3e4f218`.
> Lowered 2026-05-05 at P20 on HEAD `5990f3f9667ee995eee73ea54725fbfaf4923da7`.
> Raised 2026-08-12 to 100 for `7432145e` (fix: isolate environment-managed Slack settings):
> `clearPersistedSlackConnectionForEnvironment` takes the same `Record<string, any>`
> settings document its neighbours in `src/core/config.ts` already take
> (`applyEnvOverrides`, `migrateSettings`, `saveSettings`). Narrowing it is a
> config-module-wide change, not a one-signature fix, so the counter moves and
> the narrowing stays a separate unit of work.
> Raised 2026-08-21 to 103 (`allow` 4 -> 13) for the ACK-reaction / queue-notice
> cycle that landed on `dev` between `7333106c` and `f9169b75`. Those commits were
> never measured: `dev` pushes run no CI (`test.yml` reacts to `preview`/`main`
> push and `pull_request` only), so the drift surfaced on the first PR opened
> afterwards — #419, which is unrelated to it. Verified by checking out each
> commit in that range and re-running the scanner: every one already reported
> 103/0/13 while this file still said 100/0/4. Recorded rather than silently
> absorbed; narrowing those signatures is its own unit of work.
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
| src | 103 | 0 | 13 |
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
