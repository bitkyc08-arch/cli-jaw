# PATCH-1: Default workingDir — `~/` → `~/.cli-jaw`

**Files**: `src/core/config.ts`, `bin/commands/init.ts`
**Impact**: Fresh installs only (existing users unaffected)
**Smoke-tested**: ✅ 2026-02-26 (all 4 CLIs pass from `~/.cli-jaw`)

---

## 1. `src/core/config.ts:101` — Default setting

```diff
-        workingDir: os.homedir(),
+        workingDir: JAW_HOME,
```

`JAW_HOME` = `join(os.homedir(), '.cli-jaw')` — already defined at line 27.

---

## 2. `bin/commands/init.ts:46` — Init wizard default

```diff
-    await ask('Working directory', settings.workingDir || os.homedir());
+    await ask('Working directory', settings.workingDir || path.join(os.homedir(), '.cli-jaw'));
```

`path` and `os` already imported at lines 8-9.
