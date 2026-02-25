# B.md (AGENTS.md) Session Invalidation Fix

> Date: 2026-02-25
> Target: `src/prompt/builder.ts` L541-562 `regenerateB()`
> Status: **Done — applied Option A (invalidation removed)**

---

## 1. Problem

Every time a user sends a message, the session gets invalidated:

```
[prompt] AGENTS.md generated at /Users/junny
[claw:session] invalidated — B.md changed
```

This forces a **new session** on every message, breaking conversation continuity. Users lose context, resume stops working, and Claude/Copilot start fresh each time.

### Root Cause

`regenerateB()` is called by `spawnAgent()` (spawn.ts L193) on every non-internal, non-fallback spawn:

```typescript
export function regenerateB() {
    const fullPrompt = getSystemPrompt();
    fs.writeFileSync(join(PROMPTS_DIR, 'B.md'), fullPrompt);   // always overwrites
    fs.writeFileSync(join(wd, 'AGENTS.md'), fullPrompt);       // always overwrites

    // THIS is the bug:
    if (session.session_id) {
        updateSession.run(session.active_cli, null, ...);  // session_id = null!
        console.log('[claw:session] invalidated — B.md changed');
    }
}
```

The function **unconditionally** nullifies `session_id` every time it runs, regardless of whether the prompt content actually changed.

---

## 2. Web Search Verification — Resume + System Prompt

All 4 CLIs dynamically reload system prompt files on resume:

| CLI | Mechanism | Source |
|-----|-----------|--------|
| **Claude** | Reads `CLAUDE.md` / `AGENTS.md` automatically at session start | Anthropic docs: "automatically loaded at the start of each session" |
| **Copilot** | Reads `AGENTS.md` + `.github/copilot-instructions.md` per-prompt | GitHub docs: "automatically included in prompts" |
| **Codex** | Re-reads working directory files on `exec resume` | OpenAI docs |
| **Gemini** | `GEMINI_SYSTEM_MD` env re-written by spawn.ts L260 each spawn | spawn.ts code + Gemini CLI docs |

**Conclusion**: Session invalidation on B.md change is **completely unnecessary**. All CLIs pick up the updated AGENTS.md on their next run automatically.

---

## 3. Fix

### Option A: Remove invalidation entirely (recommended)

```diff
 export function regenerateB() {
     const fullPrompt = getSystemPrompt();
     fs.writeFileSync(join(PROMPTS_DIR, 'B.md'), fullPrompt);
 
     try {
         const wd = settings.workingDir || os.homedir();
         fs.writeFileSync(join(wd, 'AGENTS.md'), fullPrompt);
         console.log(`[prompt] AGENTS.md generated at ${wd}`);
     } catch (e: unknown) {
         console.error(`[prompt] AGENTS.md generation failed:`, (e as Error).message);
     }
-
-    try {
-        const session: any = getSession();
-        if (session.session_id) {
-            updateSession.run(session.active_cli, null, session.model,
-                session.permissions, session.working_dir, session.effort);
-            console.log('[claw:session] invalidated — B.md changed');
-        }
-    } catch { /* DB not ready yet */ }
 }
```

**Pros**: Simplest, most correct. Sessions persist. All CLIs handle it.
**Cons**: None identified.

### Option B: Invalidate only when content actually changes

```typescript
export function regenerateB() {
    const fullPrompt = getSystemPrompt();
    const bPath = join(PROMPTS_DIR, 'B.md');

    // Compare before writing
    let changed = true;
    try {
        const existing = fs.readFileSync(bPath, 'utf8');
        changed = existing !== fullPrompt;
    } catch { /* first run */ }

    if (!changed) return;  // nothing to do

    fs.writeFileSync(bPath, fullPrompt);
    // ... rest unchanged ...
}
```

**Pros**: Only regenerates when actually needed, saves I/O.
**Cons**: Still doesn't need session invalidation (CLIs handle it), adds complexity.

### Recommendation: Option A

Session invalidation is never needed. The content-diff check (Option B) is a nice optimization but separate from the bug fix.

---

## 4. Impact

- **Before**: Every message → session reset → new session → 10-message history block injected → no context from previous turns
- **After**: Sessions persist across messages → resume works → conversation stays continuous → history block only on genuinely new sessions

---

## 5. Verification

```bash
npm run build
npm test        # 252 pass expected
```

### Manual
1. Send 3 messages via web UI
2. Check console: should NOT see `[claw:session] invalidated — B.md changed`
3. Verify `session_id` in DB persists between messages
4. Confirm resume works: `SELECT session_id FROM session WHERE id='default'` should have a value

---

## 6. Risk

| Risk | Assessment |
|------|-----------|
| System prompt not updated on resume | **None** — all CLIs read AGENTS.md dynamically (verified via web search) |
| Edge case: CLI changes mid-session | Already handled by `spawnAgent()` L234-236 which checks `session.active_cli === cli` |
| Employee prompt changes | Handled separately by `getEmployeePromptV2()` — not via B.md |
