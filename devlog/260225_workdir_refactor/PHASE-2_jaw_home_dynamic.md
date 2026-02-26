# Phase 2: JAW_HOME Dynamic (env var + --home flag)

**Status**: Planning
**Files**: Phase 2.0: 8 files (import refactor) + Phase 2.1-2.2: 2 files (env var + --home) = **10 files total, ~30 lines**
**Dependency**: Phase 1 (workingDir must be JAW_HOME-based first)

> ⚠️ **REVIEW FIX (2026-02-26)**: Original plan said "2 files, ~15 lines" but 
> **8 files define their own local JAW_HOME** instead of importing from config.ts.
> These must be centralized FIRST (Phase 2.0) before the env var change works.

---

## Phase 2.0: Centralize JAW_HOME Imports (PREREQUISITE)

Currently these files define `const JAW_HOME = ...` locally instead of importing from `config.ts`:

| File | Line | Current Code | Correct Import Path |
|------|------|-------------|---------------------|
| `bin/commands/doctor.ts` | 11 | `const JAW_HOME = path.join(os.homedir(), '.cli-jaw')` | `../../src/core/config.js` |
| `bin/commands/init.ts` | 11 | `const JAW_HOME = path.join(os.homedir(), '.cli-jaw')` | `../../src/core/config.js` |
| `bin/commands/mcp.ts` | 29 | `const JAW_HOME = join(homedir(), '.cli-jaw')` | `../../src/core/config.js` |
| `bin/commands/browser.ts` | 13 | `const JAW_HOME = join(homedir(), '.cli-jaw')` | `../../src/core/config.js` |
| `bin/commands/skill.ts` | 16 | `const JAW_HOME = join(homedir(), '.cli-jaw')` | `../../src/core/config.js` |
| `bin/commands/launchd.ts` | 15 | `const LOG_DIR = join(homedir(), '.cli-jaw', 'logs')` | `../../src/core/config.js` |
| `lib/mcp-sync.ts` | 17 | `const JAW_HOME = join(os.homedir(), '.cli-jaw')` | `../src/core/config.js` ⚠️ |
| `bin/postinstall.ts` | 28 | `const jawHome = path.join(home, '.cli-jaw')` | `../src/core/config.js` ⚠️ |

> ⚠️ **REVIEW FIX R3**: Import paths differ by file location:
> - `bin/commands/*.ts` → `../../src/core/config.js` (confirmed: browser.ts:9, status.ts:6 already use this)
> - `lib/*.ts` → `../src/core/config.js` (different depth — **NOT** `../../`)
> - `bin/*.ts` (non-commands) → `../src/core/config.js` (different depth)
> 
> Using the wrong relative path = immediate build error. Per-file paths are in the table above.

**Fix for `bin/commands/*.ts`** (doctor, init, mcp, browser, skill):
```diff
-const JAW_HOME = path.join(os.homedir(), '.cli-jaw');
+import { JAW_HOME } from '../../src/core/config.js';
```

**Fix for `lib/mcp-sync.ts`:**
```diff
-const JAW_HOME = join(os.homedir(), '.cli-jaw');
+import { JAW_HOME } from '../src/core/config.js';
```

**Fix for `bin/commands/launchd.ts`:**
```diff
-const LOG_DIR = join(homedir(), '.cli-jaw', 'logs');
+import { JAW_HOME } from '../../src/core/config.js';
+const LOG_DIR = join(JAW_HOME, 'logs');
```

**Fix for `bin/postinstall.ts`:**
```diff
-const jawHome = path.join(home, '.cli-jaw');
+import { JAW_HOME as jawHome } from '../src/core/config.js';
```

> Note: postinstall.ts has legacy migration logic (`legacyHome → jawHome`) that may need to keep
> the hardcoded path for the legacy check only. The main `jawHome` should use the import.

**Test**: After Phase 2.0, all 252 existing tests must pass unchanged. This is a pure refactor.

---

## Diffs

### 2.1 `src/core/config.ts:27` — env var support

```diff
-export const JAW_HOME = join(os.homedir(), '.cli-jaw');
+export const JAW_HOME = process.env.CLI_JAW_HOME
+    ? resolve(process.env.CLI_JAW_HOME.replace(/^~/, os.homedir()))
+    : join(os.homedir(), '.cli-jaw');
```

Note: `resolve()` handles relative paths but does NOT expand `~`.
We must explicitly `.replace(/^~/, os.homedir())` before `resolve()`.
Add `import { resolve } from 'path'` if not already present (`join` is imported, need `resolve`).

### 2.2 `bin/cli-jaw.ts` — --home flag (before command parsing)

> ⚠️ **REVIEW FIX R3**: The current entrypoint does `const command = process.argv[2]` at line 22.
> If user runs `jaw --home /path doctor`, then `process.argv[2]` = `--home` and command becomes
> `'--home'` instead of `'doctor'` — the switch/case would fall to default (error).
>
> **The --home parsing + argv splice MUST happen BEFORE `const command = process.argv[2]`.**
> This means inserting the --home block at the TOP of cli-jaw.ts, between the `pkg` loading
> and the `const command` assignment.

```diff
 // After pkg loading (lines 13-19), BEFORE command parsing:

+// ─── --home flag: must run BEFORE command parsing + config.ts import ───
+import { resolve as pathResolve } from 'node:path';
+import os from 'node:os';
+const homeIdx = process.argv.indexOf('--home');
+if (homeIdx !== -1 && process.argv[homeIdx + 1]) {
+    process.env.CLI_JAW_HOME = pathResolve(
+        process.argv[homeIdx + 1].replace(/^~/, os.homedir())
+    );
+    // Remove --home and its value from argv so subcommands don't see it
+    process.argv.splice(homeIdx, 2);
+}
+
 const command = process.argv[2];  // ← NOW this correctly gets 'doctor', not '--home'
```

This must go **before** `const command = process.argv[2]` (line 22) because:
1. `--home /path` consumes 2 argv positions → splice shifts everything
2. After splice, `process.argv[2]` is the actual command (`doctor`, `serve`, etc.)
3. `config.ts` is loaded at import time by subcommands → env var must be set first

**Full execution order:**
```
jaw --home /path doctor --json
  1. Parse --home → set CLI_JAW_HOME env var
  2. Splice --home + /path from argv → argv becomes [node, jaw, doctor, --json]
  3. const command = process.argv[2] → 'doctor'
  4. switch('doctor') → import('./commands/doctor.js')
  5. doctor.ts imports config.ts → config.ts reads CLI_JAW_HOME → correct JAW_HOME
```

### 2.3 Help text update in `bin/cli-jaw.ts`

```diff
   ${c.bold}Options:${c.reset}
+    --home     데이터 디렉토리 지정 (기본: ~/.cli-jaw)
     --help     도움말 표시
     --version  버전 표시

   ${c.bold}Examples:${c.reset}
-    jaw serve --port 3457
+    jaw serve
+    jaw serve --home ~/.jaw-work --port 3458
     jaw init
```

---

## Cascading Effect

> ⚠️ **REVIEW FIX**: Original plan claimed "49 references auto-follow" — this is only true AFTER
> Phase 2.0 centralizes all local JAW_HOME definitions. Without Phase 2.0, 6 files would still
> point to `~/.cli-jaw` regardless of the env var.

**After Phase 2.0**, `config.ts` 에서 JAW_HOME이 바뀌면 아래 상수가 **전부 자동으로 따라감**:

```
PROMPTS_DIR = join(JAW_HOME, 'prompts')     ← 자동
DB_PATH = join(JAW_HOME, 'jaw.db')          ← 자동
SETTINGS_PATH = join(JAW_HOME, 'settings.json') ← 자동
SKILLS_DIR = join(JAW_HOME, 'skills')       ← 자동
UPLOADS_DIR = join(JAW_HOME, 'uploads')     ← 자동
... + all files now importing from config.ts
```

**Files that already import correctly** (no change needed):
- `src/memory/memory.ts`, `src/memory/worklog.ts`
- `src/browser/connection.ts`, `src/browser/actions.ts`
- `src/prompt/builder.ts`, `server.ts`

`createDefaultSettings().workingDir` = `JAW_HOME` (Phase 1에서 변경됨) → 자동으로 새 JAW_HOME 사용.

---

## Test Plan

### Unit Tests (new: `tests/unit/jaw-home-env.test.ts`)

```typescript
test('P2-001: JAW_HOME respects CLI_JAW_HOME env var', () => {
    // This is tricky because config.ts evaluates at import time.
    // Test via subprocess:
    const result = execSync(
        'CLI_JAW_HOME=/tmp/test-jaw node -e "const c = await import(\'./dist/src/core/config.js\'); console.log(c.JAW_HOME)"',
        { cwd: projectRoot, encoding: 'utf8' }
    );
    assert.equal(result.trim(), '/tmp/test-jaw');
});

test('P2-002: JAW_HOME defaults to ~/.cli-jaw without env var', () => {
    const result = execSync(
        'node -e "const c = await import(\'./dist/src/core/config.js\'); console.log(c.JAW_HOME)"',
        { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: '' }
    });
    assert.ok(result.trim().endsWith('.cli-jaw'));
});

test('P2-003: --home flag sets CLI_JAW_HOME before subcommand', () => {
    // ⚠️ REVIEW FIX R2: Stronger verification needed.
    // doctor --json returns { checks: [...] } with name + status + detail.
    // The "Home directory" check (doctor.ts:63-65) runs accessSync(JAW_HOME, W_OK).
    // If JAW_HOME is correctly set to tmpHome, the detail field shows tmpHome path.
    // If NOT set, it shows ~/.cli-jaw — so we can assert the path.
    const tmpHome = '/tmp/test-jaw-p2';
    mkdirSync(tmpHome, { recursive: true });
    const result = execSync(
        `node dist/bin/cli-jaw.js --home ${tmpHome} doctor --json`,
        { cwd: projectRoot, encoding: 'utf8' }
    );
    const json = JSON.parse(result);
    // "Home directory" check's detail field = JAW_HOME path (doctor.ts:65: return JAW_HOME)
    const homeCheck = json.checks.find(c => c.name === 'Home directory');
    assert.ok(homeCheck, 'Home directory check should exist');
    assert.equal(homeCheck.detail, tmpHome,
        `JAW_HOME should be ${tmpHome}, got ${homeCheck.detail}`);
    assert.equal(homeCheck.status, 'ok', 'Custom home should be writable');
    rmSync(tmpHome, { recursive: true, force: true });
});
```

### Smoke Tests (manual)

```bash
# 1. Default behavior unchanged
jaw serve                     # should use ~/.cli-jaw

# 2. Custom home
mkdir -p /tmp/test-jaw
jaw --home /tmp/test-jaw doctor    # should show /tmp/test-jaw paths
ls /tmp/test-jaw/                  # should create structure

# 3. Env var
CLI_JAW_HOME=/tmp/test-jaw2 jaw doctor

# 4. Two instances simultaneously
jaw serve &                                    # port 3457
jaw serve --home ~/.jaw-work --port 3458 &     # port 3458
curl localhost:3457/api/cli-status             # instance A
curl localhost:3458/api/cli-status             # instance B
```

> ⚠️ **REVIEW FIX**: `/api/status` does NOT exist. The actual endpoint is `/api/cli-status`.
> Also, the response does NOT include a `jawHome` field.

---

## Edge Cases

| Case | Behavior |
|------|----------|
| `--home ~/relative` | Explicit `~` replacement + `resolve()` normalizes to absolute |
| `--home` without value | Ignored (no crash) |
| Non-existent dir + `jaw serve` | `init` flow creates dirs (postinstall/init.ts) |
| Non-existent dir + `jaw doctor` | **FAILS**: `accessSync(JAW_HOME, W_OK)` throws (doctor.ts:64). This is correct — doctor should report missing dirs, not silently create them. Clone/init must run first. |
| `CLI_JAW_HOME` + `--home` both set | `--home` wins (sets env var, overwrites) |

---

## Rollback

Phase 2.0 (centralization): Revert 8 files to local definitions. Safe — no data affected.
Phase 2.1-2.3 (env var + --home): Revert config.ts + cli-jaw.ts. No data affected — custom JAW_HOME dirs stay as-is.
