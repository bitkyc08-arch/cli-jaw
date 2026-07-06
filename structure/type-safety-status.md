# Type Safety Status

Last updated: 2026-07-06

> Live source of truth: `docs/migration/strict-baseline.md` + `node scripts/check-strict-baseline.mjs`
> (ratchet gate). This document is narrative context only — do not hand-maintain counts here.
> 2026-07-06 status: baseline gate is **failing** — `src.any live=95 > baseline=93` (+2 regression).

## TypeScript Gate

`tsconfig.json` keeps the strict profile enabled.

| Flag | Status |
|------|--------|
| `strict` | enabled |
| `noUnusedLocals` | enabled |
| `noUnusedParameters` | enabled |
| `noImplicitReturns` | enabled |
| `noFallthroughCasesInSwitch` | enabled |
| `noUncheckedIndexedAccess` | enabled |
| `noImplicitOverride` | enabled |
| `noPropertyAccessFromIndexSignature` | enabled |
| `exactOptionalPropertyTypes` | enabled |
| `allowUnusedLabels` | disabled |
| `allowUnreachableCode` | disabled |

Current verification target: `npm run typecheck` / `npx tsc --noEmit` must stay clean. This document tracks escape hatches separately from compiler success.

## Directive Inventory

Current scan scope:

```bash
rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error" src bin public/js public/manager/src --glob "*.ts" --glob "*.tsx"
```

Result on 2026-06-10:

| Directive | Count | Status |
|---|---:|---|
| `@ts-nocheck` | 0 | resolved |
| `@ts-ignore` | 0 | resolved |
| `@ts-expect-error` | 0 | resolved |

The old adaptive-fetch `@ts-nocheck` debt remains closed.

## Explicit Any Inventory

Current broad scan:

```bash
rg -n "as any|: any|any\\[\\]|Record<string, any>|Promise<any>|Array<any>|<any>" src bin public/js public/manager/src --glob "*.ts" --glob "*.tsx"
```

Result on 2026-07-06: 100 matches across application/runtime surfaces (was 85 on 2026-06-10 — trending up; see strict-baseline gate). This is not a compile failure, but it is no longer accurate to claim only a handful of casts remain.

Top current hotspots by file:

| File | Matches | Notes |
|---|---:|---|
| `src/core/config.ts` | 11 | settings/default migration and dynamic config shapes |
| `src/agent/spawn/queue.ts` | 9 | persisted queue row/object boundary |
| `src/orchestrator/pipeline.ts` | 6 | orchestration context and persisted state normalization |
| `src/routes/employees.ts` | 5 | request/response shape boundary |
| `src/memory/heartbeat.ts` | 5 | heartbeat schedule/config normalization |
| `src/messaging/runtime.ts` | 4 | transport registry boundary |
| `src/core/main-session.ts` | 4 | SQLite row/session shape boundary |
| `src/core/settings-merge.ts` | 3 | dynamic deep merge boundary |
| `src/cli/readiness.ts` | 3 | CLI-specific readiness payloads |
| `src/agent/memory-flush-controller.ts` | 3 | SQLite prepared-statement row casting |

## Policy

- Do not reintroduce TypeScript suppression directives.
- Keep boundary casts close to IO or dynamic config parsing.
- Prefer typed row mappers, discriminated unions, and local normalization helpers before adding new `any`.
- If a broad `any` is unavoidable at a boundary, keep it narrow and document the shape in the adjacent mapper or parser.

## Verification

Required checks after type-safety changes:

```bash
npm run typecheck
rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error" src bin public/js public/manager/src --glob "*.ts" --glob "*.tsx"
```
