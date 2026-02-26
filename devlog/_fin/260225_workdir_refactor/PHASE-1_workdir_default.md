# Phase 1: workingDir Default → JAW_HOME

**Status**: Smoke-tested ✅ — Ready for implementation
**Files**: 4 files, 5 lines
**Dependency**: None (standalone)

---

## Diffs

### 1.1 `src/core/config.ts:101`

```diff
-        workingDir: os.homedir(),
+        workingDir: JAW_HOME,
```

### 1.2 `bin/commands/init.ts:46`

```diff
-    await ask('Working directory', settings.workingDir || os.homedir());
+    await ask('Working directory', settings.workingDir || path.join(os.homedir(), '.cli-jaw'));
```

### 1.3 `src/prompt/builder.ts:210`

```diff
-- ~/
+- ~/.cli-jaw
```

### 1.4 `bin/postinstall.ts:166-167`

```diff
-const agentsMd = path.join(home, 'AGENTS.md');
-const claudeMd = path.join(home, 'CLAUDE.md');
+const agentsMd = path.join(jawHome, 'AGENTS.md');
+const claudeMd = path.join(jawHome, 'CLAUDE.md');
```

---

## Test Plan

### Unit Tests (new: `tests/unit/workdir-default.test.ts`)

```typescript
test('P1-001: createDefaultSettings workingDir is JAW_HOME', () => {
    // import createDefaultSettings, verify workingDir === JAW_HOME
});

test('P1-002: A2_DEFAULT contains ~/.cli-jaw not ~/', () => {
    // import A2_DEFAULT, assert includes('~/.cli-jaw')
});
```

### Smoke Tests (manual, post-build)

```bash
# 1. Build succeeds
npm run build

# 2. Existing tests pass (252+)
npm test

# 3. ~/AGENTS.md removed, verify CLI spawn from ~/.cli-jaw works
mv ~/AGENTS.md ~/AGENTS.md.bak
cd ~/.cli-jaw && claude --print "your name?" # should say Jaw Agent
mv ~/AGENTS.md.bak ~/AGENTS.md
```

---

## Rollback

Revert the 4 lines. No data migration needed.
