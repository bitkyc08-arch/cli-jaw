# PATCH-3: postinstall.ts — CLAUDE.md Symlink Target

**File**: `bin/postinstall.ts`
**Impact**: New installs and re-runs of `npm postinstall`

---

## `bin/postinstall.ts:166-167` — CLAUDE.md symlink

```diff
-const agentsMd = path.join(home, 'AGENTS.md');
-const claudeMd = path.join(home, 'CLAUDE.md');
+const agentsMd = path.join(jawHome, 'AGENTS.md');
+const claudeMd = path.join(jawHome, 'CLAUDE.md');
```

`jawHome` = `path.join(home, '.cli-jaw')` — already defined at line 24.

Before: symlink `~/CLAUDE.md` → `~/AGENTS.md`
After: symlink `~/.cli-jaw/CLAUDE.md` → `~/.cli-jaw/AGENTS.md`

This ensures `postinstall` no longer creates pollution files in `~/`.
