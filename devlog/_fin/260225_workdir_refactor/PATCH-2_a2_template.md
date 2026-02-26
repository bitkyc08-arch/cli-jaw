# PATCH-2: A-2 Template — Working Directory Reference

**File**: `src/prompt/builder.ts`
**Impact**: New installs only (existing `A-2.md` is user-owned, never overwritten)

---

## `src/prompt/builder.ts:210` — A-2 Default Template

```diff
 ## Working Directory
-- ~/
+- ~/.cli-jaw
```

This is informational text in the AI prompt — the actual cwd comes from `settings.workingDir` in `spawn.ts:465`.
