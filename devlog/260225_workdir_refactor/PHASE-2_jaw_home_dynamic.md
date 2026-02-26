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
+    ? resolve(process.env.CLI_JAW_HOME.replace(/^~(?=\/|$)/, os.homedir()))
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
+import { parseArgs } from 'node:util';
+
+// parseArgs with strict:false — handles both --home /path and --home=/path
+const { values: globalOpts, positionals: rawPositionals } = parseArgs({
+    args: process.argv.slice(2),
+    options: { home: { type: 'string' } },
+    strict: false,
+    allowPositionals: true,
+});
+if (globalOpts.home) {
+    process.env.CLI_JAW_HOME = pathResolve(
+        String(globalOpts.home).replace(/^~(?=\/|$)/, os.homedir())
+    );
+}
+// Rebuild argv without --home so subcommands see clean positionals
+process.argv = [process.argv[0], process.argv[1], ...rawPositionals];
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

> ⚠️ **REVIEW FIX R6-1 (ESM Hoisting Safety)**:
> cli-jaw.ts currently only has static imports from Node built-ins (`node:path`, `node:url`, `node:fs`).
> All subcommand loading uses dynamic `await import()` — so `--home` parsing runs BEFORE any internal
> module loads. **This is safe as-is — NO wrapper file needed.**
> **CONSTRAINT**: cli-jaw.ts MUST NEVER add static imports to internal modules (e.g., `config.ts`).
> If a static import chain reaches `config.ts`, ESM hoisting would freeze `JAW_HOME` before `--home` runs.

> ⚠️ **REVIEW FIX R6-2 (= syntax support)**:
> `process.argv.indexOf('--home')` does NOT match `--home=/path`. Users familiar with Unix CLI
> conventions may use `jaw --home=/path doctor`. Consider upgrading to `parseArgs({ strict: false })`
> for `--home` parsing to handle both `--home /path` and `--home=/path` forms.
> Verified: `parseArgs` correctly splits `--home=/custom/path` into `values.home = '/custom/path'`.

> ⚠️ **REVIEW FIX R6-3 (tilde regex)**:
> Regex changed from `/^~/` to `/^~(?=\/|$)/` to prevent `~username/path` from becoming
> `/Users/junnyusername/path`. New regex only matches `~/...` or standalone `~`.

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

---

## Phase 2 Ripple Effects (R4 Review, 2026-02-26)

> These are **known issues** that arise AFTER Phase 2 is applied — they don't block Phase 2
> implementation but must be addressed for multi-instance to actually work end-to-end.

### RE-1 [HIGH]: Prompt text has hardcoded `~/.cli-jaw` paths (builder.ts)

The A-1 system prompt template (`const A1_CONTENT`, builder.ts:87-192) and dynamic prompt
construction (builder.ts:361, 381, 392) contain ~10 hardcoded `~/.cli-jaw/...` strings.

**Impact**: Agent in custom-home instance gets instructions pointing to the DEFAULT instance's paths.
e.g. "read `~/.cli-jaw/skills/dev/SKILL.md`" when actual path is `~/.jaw-work/skills/dev/SKILL.md`.

**Affected lines**:
| Line | Content | Type |
|------|---------|------|
| 134 | `~/.cli-jaw/settings.json` (telegram) | A-1 template literal |
| 135 | `~/.cli-jaw/settings.json` (telegram) | A-1 template literal |
| 149 | `~/.cli-jaw/memory/MEMORY.md` | A-1 template literal |
| 167 | `~/.cli-jaw/heartbeat.json` | A-1 template literal |
| 183 | `~/.cli-jaw/skills/dev/SKILL.md` | A-1 template literal |
| 189 | `~/.cli-jaw/skills/dev/SKILL.md` | A-1 template literal |
| 361 | `~/.cli-jaw/heartbeat.json` | Dynamic string concat |
| 381 | `~/.cli-jaw/skills/dev/SKILL.md` | Dynamic string concat |
| 392 | `~/.cli-jaw/skills_ref/<name>/SKILL.md` | Dynamic string concat |

**Fix**: Replace hardcoded `~/.cli-jaw` with `${JAW_HOME}` (already imported in builder.ts:4).
- A-1 template literal: `A1_CONTENT` already uses backtick template — just interpolate `${JAW_HOME}`
- Dynamic strings: replace string literal with `\`${JAW_HOME}/...\``
- **Scope**: 1 file (builder.ts), ~10 line edits. No new imports needed.

**When**: Phase 2.1 (same time as env var change — JAW_HOME is now dynamic, so prompts must use it)

### RE-2 [HIGH]: `browser` and `memory` commands hardcode port 3457

```typescript
// bin/commands/browser.ts:11
const SERVER = getServerUrl('3457');
// bin/commands/memory.ts:7
const SERVER = getServerUrl('3457');
```

`getServerUrl('3457')` passes literal `'3457'` which takes priority over `process.env.PORT`.
Compare with `chat.ts:17` which correctly does `port: { type: 'string', default: process.env.PORT || '3457' }`.

**Impact**: `jaw --home X browser start` on port-3458 instance → browser/memory commands talk to
port 3457 (wrong instance) because they ignore the running instance's port.

**Fix**: Change to `getServerUrl(undefined)` to fall through to `process.env.PORT || DEFAULT_PORT`.
Or add `--port` option like chat.ts already does.
- **Scope**: 2 files, 1 line each. Trivial.

**When**: Phase 4 (port separation) — doesn't block Phase 2, but required for multi-instance UX.

### RE-3 [MEDIUM]: `postinstall.ts` uses `home` (homedir) for symlinks

```typescript
// bin/postinstall.ts:108
ensureSkillsSymlinks(home, { onConflict: 'backup' });  // home = os.homedir()
// bin/postinstall.ts:166-167
const agentsMd = path.join(home, 'AGENTS.md');    // ~/AGENTS.md
const claudeMd = path.join(home, 'CLAUDE.md');    // ~/CLAUDE.md
// bin/postinstall.ts:180
initMcpConfig(home);                              // home-based MCP
```

**Impact**: `npm install -g` always sets up symlinks in `~/`, not in custom home.
For default instance this is fine. For custom instances, `jaw clone` handles setup instead.

**Assessment**: NOT a Phase 2 blocker. postinstall runs once during `npm install -g`, not per-instance.
Instance-specific setup is handled by `jaw clone` (Phase 3) or `jaw init`.

**When**: Phase 3 (clone handles per-instance setup). Low priority.

### RE-4 [MEDIUM]: `mcp.ts` workingDir fallback is `homedir()`

```typescript
// bin/commands/mcp.ts:58
return JSON.parse(readFileSync(settingsPath, 'utf8')).workingDir || homedir();
```

**Assessment**: After Phase 1 (workingDir = JAW_HOME), new instances will have `workingDir = JAW_HOME`
in their settings.json. The `|| homedir()` fallback only fires if workingDir is empty/missing.
Phase 2.0 also changes mcp.ts to import JAW_HOME from config.ts, so a better fallback would be `JAW_HOME`.

**Fix**: Change `|| homedir()` to `|| JAW_HOME` in getWorkingDir().
- **Scope**: 1 file, 1 line.

**When**: Phase 2.0 (when centralizing imports — natural to fix the fallback too).

### RE-5 [MEDIUM]: launchd shell commands lack path quoting

```typescript
// bin/commands/launchd.ts:30
execSync(`mkdir -p ${LOG_DIR}`);                    // spaces → break
// bin/commands/launchd.ts:78
execSync(`launchctl unload ${PLIST_PATH}`, ...);    // spaces → break
// bin/commands/launchd.ts:120
execSync(`launchctl load -w ${PLIST_PATH}`);        // spaces → break
```

**Impact**: If JAW_HOME contains spaces (e.g. `/Users/John Smith/.cli-jaw`), these commands break.
Currently safe because default `~/.cli-jaw` has no spaces, but custom `--home` paths might.

**Fix**: Quote all interpolated paths: `"${LOG_DIR}"`, `"${PLIST_PATH}"`.
- **Scope**: 1 file, 3 lines.

**When**: Phase 4 (launchd multi-instance). Low risk for Phase 2 since default path has no spaces.
