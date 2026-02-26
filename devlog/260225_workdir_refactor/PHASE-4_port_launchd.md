# Phase 4: Port Separation + Multi-Instance launchd

**Status**: Planning
**Files**: 4 files modified (~40 lines: launchd ~30 + browser/memory/mcp ~3 each)
**Dependency**: Phase 2 (needs `--home` flag support)

---

## Sub-phases

### Phase 4.1: launchd multi-instance support

Currently `launchd.ts` hardcodes:
- `LABEL = 'com.cli-jaw.serve'` (one plist only)
- `WorkingDirectory = homedir()` (should be JAW_HOME)
- No `--port` or `--home` pass-through

### Phase 4.2: Verify server.ts port isolation (already works)

`server.ts:95` already does `process.env.PORT || 3457` — just need launchd to pass it.

---

## Diffs

### 4.1 `bin/commands/launchd.ts` — Multi-instance plist

```diff
-const LABEL = 'com.cli-jaw.serve';
-const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
-const LOG_DIR = join(homedir(), '.cli-jaw', 'logs');
+import { JAW_HOME } from '../../src/core/config.js';
+import { createHash } from 'node:crypto';
+import { parseArgs } from 'node:util';
+
 function instanceId(): string {
-    // ~/.cli-jaw → 'default', ~/.jaw-work → 'jaw-work'
     const base = basename(JAW_HOME);
-    return base === '.cli-jaw' ? 'default' : base.replace(/^\./, '');
+    if (base === '.cli-jaw') return 'default';
+    // Hash full path to prevent collision (~/a/.jaw vs ~/b/.jaw)
+    const hash = createHash('md5').update(JAW_HOME).digest('hex').slice(0, 8);
+    return `${base.replace(/^\./, '')}-${hash}`;
 }
+
+const INSTANCE = instanceId();
+const LABEL = `com.cli-jaw.${INSTANCE}`;
+const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
+const LOG_DIR = join(JAW_HOME, 'logs');
```

### 4.1.2 `generatePlist()` — Pass --home and --port

```diff
+// XML escape helper — prevents silent plist parse failures on &, <, > in paths
+const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
+
 function generatePlist(): string {
     const nodePath = getNodePath();
     const jawPath = getJawPath();
+    // parseArgs handles both --port 3458 and --port=3458
+    const { values } = parseArgs({
+        args: process.argv.slice(2),
+        options: { port: { type: 'string', default: '3457' } },
+        strict: false,
+        allowPositionals: true,
+    });
+    const port = values.port as string;
-    execSync(`mkdir -p ${LOG_DIR}`);
+    execSync(`mkdir -p "${LOG_DIR}"`);

     return `<?xml version="1.0" encoding="UTF-8"?>
 ...
     <key>ProgramArguments</key>
     <array>
-        <string>${nodePath}</string>
-        <string>${jawPath}</string>
+        <string>${xmlEsc(nodePath)}</string>
+        <string>${xmlEsc(jawPath)}</string>
+        <string>--home</string>
+        <string>${xmlEsc(JAW_HOME)}</string>
         <string>serve</string>
+        <string>--port</string>
+        <string>${port}</string>
     </array>
     ...
     <key>WorkingDirectory</key>
-    <string>${homedir()}</string>
+    <string>${xmlEsc(JAW_HOME)}</string>
     ...
+    <key>EnvironmentVariables</key>
+    <dict>
+        <key>PATH</key>
+        <string>${xmlEsc(process.env.PATH || '')}</string>
+        <key>CLI_JAW_HOME</key>
+        <string>${xmlEsc(JAW_HOME)}</string>
+    </dict>
     ...`;
 }
```

### 4.1.3 Status/unset commands — use dynamic LABEL

```diff
 function getStatus(): string | null {
     try {
-        const out = execSync(`launchctl list | grep ${LABEL}`, ...);
+        const out = execSync(`launchctl list | grep ${LABEL}`, ...);
         // (LABEL is now dynamic — already works)
```

No code change needed — `LABEL` is module-level, already used throughout.

---

## Usage After Phase 4

```bash
# Default instance
jaw launchd                               # com.cli-jaw.default, port 3457

# Work instance
jaw --home ~/.jaw-work launchd --port 3458  # com.cli-jaw.jaw-work, port 3458

# Lab instance
jaw --home ~/.jaw-lab launchd --port 3459   # com.cli-jaw.jaw-lab, port 3459

# Status
jaw launchd status                          # default instance
jaw --home ~/.jaw-work launchd status       # work instance

# List all jaw instances
launchctl list | grep com.cli-jaw
# com.cli-jaw.default     (port 3457)
# com.cli-jaw.jaw-work    (port 3458)
```

---

## Test Plan

### Unit Tests (`tests/unit/launchd-multi.test.ts`)

```typescript
test('P4-001: instanceId returns "default" for ~/.cli-jaw', () => {
    // With CLI_JAW_HOME unset → JAW_HOME = ~/.cli-jaw → instanceId() = 'default'
});

test('P4-002: instanceId returns "jaw-work" for ~/.jaw-work', () => {
    // With CLI_JAW_HOME=~/.jaw-work → instanceId() = 'jaw-work'
});

test('P4-003: LABEL includes instance id', () => {
    // Verify LABEL = 'com.cli-jaw.jaw-work' format
});

test('P4-004: generatePlist includes --home flag', () => {
    // Parse plist output, verify ProgramArguments contains --home
});

test('P4-005: generatePlist includes --port flag', () => {
    // Parse plist output, verify ProgramArguments contains --port
});

test('P4-006: LOG_DIR uses JAW_HOME not hardcoded path', () => {
    // With custom JAW_HOME, verify LOG_DIR points to JAW_HOME/logs
});
```

### Smoke Test (manual, macOS only)

> ⚠️ **REVIEW FIX R2**: 
> - `jaw launchd` has no `--dry-run` flag. Must actually install to test.
> - `launchd status` output shows PID/plist/log path only — NO port number.
>   Port verification requires `curl` to the expected port.
> - `launchctl load/unload` is legacy — modern macOS recommends `bootstrap/bootout`.
>   Consider migrating in Phase 4, but keep load/unload for compatibility with older macOS.

```bash
# Test 1: default instance
jaw launchd                                   # install default (port 3457)
jaw launchd status                            # verify running (shows PID)
curl -s localhost:3457/api/cli-status | head   # verify port 3457 responds

# Test 2: custom instance (MUST specify --port to avoid conflict)
mkdir -p ~/.jaw-test
jaw --home ~/.jaw-test launchd --port 3458    # install custom instance
launchctl list | grep cli-jaw                 # should show 2 entries
curl -s localhost:3458/api/cli-status | head   # verify port 3458 responds

# Test 3: status of custom instance
jaw --home ~/.jaw-test launchd status         # verify PID + plist path

# Cleanup
jaw --home ~/.jaw-test launchd unset
jaw launchd unset
rm -rf ~/.jaw-test
```

### Integration Test: Two instances simultaneously

```bash
# Start two instances
jaw serve &                                      # port 3457, ~/.cli-jaw
jaw serve --home /tmp/jaw-test --port 3458 &     # port 3458, /tmp/jaw-test

# Verify independence
# NOTE: /api/cli-status returns CLI detection info, NOT jawHome.
# To verify independence, check that each instance has its own DB:
curl localhost:3457/api/cli-status               # should respond
curl localhost:3458/api/cli-status               # should respond

# Verify separate DBs by sending messages to each and checking they don't cross
# (manual verification via web UI at localhost:3457 vs localhost:3458)

# Cleanup
kill %1 %2
rm -rf /tmp/jaw-test
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Two instances same port | Second one fails to bind → clear error message |
| Unset wrong instance | `jaw --home X launchd unset` only removes that plist |
| No `--port` passed to launchd | Defaults to 3457 (may conflict with default) |
| Instance dir deleted but plist remains | launchd restarts → jaw creates dirs on startup |

---

## Cross-Platform Note

`launchd.ts` is macOS-only. Linux would use systemd (`jaw systemd`), Windows would
use Windows Service. These are Phase 99 concerns.

### launchd API Legacy Note

Current code uses `launchctl load -w` / `launchctl unload` (launchd.ts:120, 78, 109).
These are **legacy** subcommands — Apple recommends `bootstrap`/`bootout` since macOS 10.10+.

```bash
# Legacy (current):
launchctl load -w ~/Library/LaunchAgents/com.cli-jaw.serve.plist
launchctl unload ~/Library/LaunchAgents/com.cli-jaw.serve.plist

# Modern (recommended):
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cli-jaw.serve.plist
launchctl bootout gui/$(id -u)/com.cli-jaw.serve
```

**Decision**: Keep `load/unload` for now (wider macOS version compatibility).
Consider migration to `bootstrap/bootout` as a separate improvement task.
Legacy commands still work on macOS 14+ (Sonoma) but print deprecation warnings on some versions.

---

## Rollback

Revert `launchd.ts` changes. Existing single-instance plist continues to work.
