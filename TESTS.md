# 🧪 CLI-CLAW Tests

[![Tests](https://img.shields.io/badge/tests-65%20pass-brightgreen)](#)

> `node:test` + `node:assert` — zero external dependencies.

## Run

```bash
npm test                            # All 65 tests (~90ms)
node --test tests/unit/*.test.js    # Unit tests only
npm run test:watch                  # Watch mode
```

## Test Files

### Root (Tier 2 — event parsing + telegram)

| File | Tests | Coverage |
|------|:-----:|----------|
| `events.test.js` | 12 | NDJSON parser, session ID, tool labels, multi-CLI paths |
| `events-acp.test.js` | 4 | ACP `session/update` — 5 event types |
| `telegram-forwarding.test.js` | 10 | Origin filter, fallback, chunking, markdown, lifecycle |

### Unit (Tier 1-2 — pure functions)

| File | Tests | Coverage |
|------|:-----:|----------|
| `cli-registry.test.js` | 8 | CLI_KEYS, required fields, buildDefaultPerCli, buildModelChoicesByCli |
| `bus.test.js` | 6 | Broadcast, listener add/remove, WS mock, safety |
| `commands-parse.test.js` | 15 | parseCommand, executeCommand, getCompletions, COMMANDS integrity |
| `worklog.test.js` | 5 | PHASES constant, parseWorklogPending |

## Tier Model

| Tier | Description | Status |
|:----:|-------------|:------:|
| 1 | Pure functions (zero deps) | ✅ |
| 2 | Light I/O (tmp dir isolation) | ✅ |
| 3 | Integration (mock/stub needed) | 🔜 |
| 4 | E2E (server + CLI) | 💭 |

## Adding Tests

```bash
# Create a new test file
# tests/unit/<module>.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

test('my test', () => {
    assert.equal(1 + 1, 2);
});
```

Tests use Node's built-in test runner — no configuration needed.
