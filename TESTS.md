# 🧪 CLI-JAW Tests

[![Tests](https://img.shields.io/badge/tests-548%20pass-brightgreen)](#)

> `node:test` + `node:assert` via `tsx` runner — zero external test dependencies.

## Run

```bash
npm test                            # All 548 tests (~14s)
tsx --test tests/unit/*.test.ts    # Unit tests only
tsx --test tests/integration/*.test.ts  # Integration tests only
npm run test:watch                  # Watch mode
npm run test:coverage               # Coverage report (Node 22+)
npm run test:smoke                  # API smoke tests (requires running server)
npm run check:deps                  # Dependency vulnerability check
```

---

## Test Files

### Root (Tier 2 — event parsing + external integration)

| File                          | Tests | Coverage                                                                        |
| ----------------------------- | :---: | ------------------------------------------------------------------------------- |
| `acp-client.test.ts`          |   8   | ACP JSON-RPC: requests, notifications, permissions, heartbeat, activity timeout |
| `events.test.ts`              |   8   | NDJSON parser, session ID, tool labels, multi-CLI fixture matrix                |
| `events-acp.test.ts`          |   4   | ACP `session/update` — thought/tool/message/plan event types                    |
| `telegram-forwarding.test.ts` |  12   | Origin filter, fallback, chunking, markdown→HTML, lifecycle attach/detach       |

### Unit (Tier 1 — pure functions, zero I/O)

| File                           | Tests | Coverage                                                                                  |
| ------------------------------ | :---: | ----------------------------------------------------------------------------------------- |
| `agent-args.test.ts`           |  16   | `buildArgs` / `buildResumeArgs` — 5 CLIs × model/effort/permissions combos                |
| `async-handler.test.ts`        |   4   | Express async wrapper, error forwarding, statusCode preservation                          |
| `bus.test.ts`                  |   6   | Broadcast, listener add/remove, WS mock, safety                                           |
| `cli-registry.test.ts`         |   8   | CLI_KEYS, required fields, `buildDefaultPerCli`, `buildModelChoicesByCli`                 |
| `commands-parse.test.ts`       |  21   | parseCommand, executeCommand, getCompletions, COMMANDS integrity, i18n                    |
| `commands-policy.test.ts`      |   8   | Command-contract capability map, `getVisibleCommands`, Telegram menu, readonly, tgDescKey |
| `decode.test.ts`               |   5   | `decodeFilenameSafe` — URL encoding, traversal prevention                                 |
| `deps-check.test.ts`           |  10   | Semver range matching, advisory detection, offline vulnerability check                    |
| `frontend-constants.test.ts`   |   2   | ROLE_PRESETS structure, CLI registry schema                                               |
| `heartbeat-queue.test.ts`      |   4   | Pending queue enqueue/dequeue, max size, drain order                                      |
| `help-renderer.test.ts`        |   5   | `renderHelp` list/detail mode, markdown formatting                                        |
| `http-response.test.ts`        |   6   | `ok()` / `fail()` standard response format, status codes                                  |
| `i18n.test.ts`                 |  26   | Locale loading, fallback chains, interpolation, plural rules                              |
| `orchestrator-parsing.test.ts` |  13   | `parseSubtasks`, `parseDirectAnswer`, `stripSubtaskJSON` — fenced/raw/malformed           |
| `orchestrator-triage.test.ts`  |  10   | `isContinueIntent`, `needsOrchestration` — signal threshold logic                         |
| `path-guards.test.ts`          |  16   | `assertSkillId`, `assertFilename`, `safeResolveUnder` — traversal/injection/overlong      |
| `render-sanitize.test.ts`      |  11   | XSS regex fallback — script/event/javascript: stripping, content preservation             |
| `settings-merge.test.ts`       |   5   | `mergeSettingsPatch` — perCli/activeOverrides deep merge                                  |
| `employee-prompt.test.ts`      |  14   | `getEmployeePrompt`, `getEmployeePromptV2`, old name exclusion                            |
| `import-resolve.test.ts`       |   1   | **전체 src/ import 경로 존재 검증** — 리팩토링 후 깨진 경로 탐지                          |
| `worklog.test.ts`              |   6   | PHASES mapping, `parseWorklogPending` extraction                                          |

### Integration (Tier 2-3 — Express routes, CLI)

| File                         | Tests | Coverage                                                           |
| ---------------------------- | :---: | ------------------------------------------------------------------ |
| `route-registration.test.ts` |   5   | Baseline route list, core/memory/browser route groups, dedup check |
| `cli-basic.test.ts`          |   4   | CLI --help, --version, unknown command, doctor                     |
| `api-smoke.test.ts`          |  12   | API endpoint smoke tests (server startup required)                 |

---

## Phase 20 Test Plan

> Phase 20 (project-wide audit) 완료 후 추가될 테스트 목록.

### 20.4-A: Coverage Measurement

```bash
npm run test:coverage    # Node --experimental-test-coverage
```

### 20.4-B: API Smoke Tests (`tests/integration/api-smoke.test.ts`)

| ID        | Endpoint                      | Assertion                 |
| --------- | ----------------------------- | ------------------------- |
| SMOKE-001 | `GET /api/session`            | 200 + session object      |
| SMOKE-002 | `GET /api/messages`           | 200 + array               |
| SMOKE-003 | `GET /api/settings`           | 200 + `cli` field         |
| SMOKE-004 | `GET /api/commands`           | 200 + array with `help`   |
| SMOKE-005 | `GET /api/runtime`            | 200                       |
| SMOKE-006 | `GET /api/employees`          | 200 + array               |
| SMOKE-007 | `GET /api/skills`             | 200                       |
| SMOKE-008 | `GET /api/memory`             | 200                       |
| SMOKE-009 | `POST /api/command` (invalid) | 200 or 400                |
| SMOKE-010 | `GET /api/nonexistent`        | 200 or 404 (SPA fallback) |
| SMOKE-011 | Path traversal `..%2F`        | 400 or 403                |
| SMOKE-012 | Skill ID injection            | 400 or 403                |

> Requires server running: `TEST_PORT=3457 npm run test:smoke`

### 20.4-C: CLI Basic Tests (`tests/integration/cli-basic.test.ts`)

| ID      | Command         | Assertion            |
| ------- | --------------- | -------------------- |
| CLI-001 | `--help`        | Shows usage/commands |
| CLI-002 | `--version`     | Matches semver       |
| CLI-003 | Unknown command | Error message        |
| CLI-004 | `doctor`        | Runs without crash   |

### 20.5: Frontend Tests (Manual)

| ID         | Area                       | Check                                        |
| ---------- | -------------------------- | -------------------------------------------- |
| XSS-001    | Skill name injection       | `<img onerror=alert(1)>` → escapeHtml blocks |
| XSS-002    | Heartbeat prompt injection | `<script>` → escapeHtml blocks               |
| XSS-003    | Attribute context          | `" onmouseover=` → `&quot;` escaping         |
| A11Y-001   | Tab navigation             | All interactive elements reachable           |
| A11Y-002   | Escape key                 | Closes open modals                           |
| A11Y-003   | ARIA labels                | Screen reader reads labels                   |
| MOBILE-001 | 375px layout               | Single column, sidebars hidden               |
| MOBILE-002 | Mobile nav                 | Bottom bar toggles sidebars                  |

---

## Tier Model

| Tier  | Description                  | Count |         Status          |
| :---: | ---------------------------- | :---: | :---------------------: |
|   1   | Pure functions (zero deps)   |  183  |            ✅            |
|   2   | Light I/O (tmp dir, fixture) |  47   |            ✅            |
|   3   | Integration (server/Express) |  16   | ✅ (route + smoke + CLI) |
|  3+   | API smoke + CLI basic        |   —   |      📋 Phase 20.4       |
|   4   | E2E (browser + full stack)   |   —   |            💭            |

---

## Test Scripts

| Script          | Command                                                         | Description                 |
| --------------- | --------------------------------------------------------------- | --------------------------- |
| `test`          | `tsx --test tests/*.test.ts tests/**/*.test.ts`                 | All tests                   |
| `test:watch`    | `tsx --test --watch ...`                                        | Watch mode                  |
| `test:coverage` | `tsx --test --experimental-test-coverage ...`                   | Coverage report             |
| `test:smoke`    | `TEST_PORT=3457 tsx --test tests/integration/api-smoke.test.ts` | API smoke (needs server)    |
| `check:deps`    | `node scripts/check-deps-offline.mjs`                           | Offline vulnerability check |

---

## Adding Tests

```js
// tests/unit/<module>.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

test('MY-001: descriptive test name', () => {
    assert.equal(1 + 1, 2);
});
```

Naming convention: `<PREFIX>-NNN: description`
- `CP-*` Commands Policy, `PG-*` Path Guards, `AG-*` Agent Args, `SM-*` Settings Merge
- `ORP-*` Orchestrator Parsing, `ORT-*` Orchestrator Triage
- `EMP-*` Employee Prompt, `IMP-*` Import Resolve
- `SMOKE-*` API Smoke, `CLI-*` CLI Basic

Tests use Node's built-in test runner — **zero configuration, zero dependencies.**
