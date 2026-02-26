# Working Directory Refactor — Default `~` -> `~/.cli-jaw`

**Date**: 2026-02-26
**Status**: Smoke-tested ✅ — Ready for implementation
**Priority**: High (prevents instruction pollution for standalone CLI users)

---

## Problem

Current defaults use `~/` (user home) as the working directory.
That means:

1. `~/AGENTS.md` is generated in user's home — visible to ALL CLI tools
2. `~/CLAUDE.md` symlink → `~/AGENTS.md` also exists
3. Agent process `cwd` starts at `~/`
4. A-2 template says `Working Directory: ~/`

### The Real Issue: Instruction Pollution

When users run Claude, Codex, or Copilot **standalone** (outside cli-jaw) in any
directory like `~/Developer/my-app/`, these CLIs **walk up the directory tree** and
discover `~/AGENTS.md` or `~/CLAUDE.md`. This causes the standalone CLI to load
the full Jaw Agent system prompt — "I am Jaw Agent, a system-level AI assistant..."
— even when the user never intended to use cli-jaw.

This pollutes every standalone Claude/Codex/Copilot session on the machine.

## How Each CLI Receives Instructions

### From cli-jaw code (spawn.ts / args.ts)

| CLI | Method | cwd-dependent? |
|-----|--------|---------------|
| Claude | `--append-system-prompt` (CLI argument) | ❌ No |
| Gemini | `GEMINI_SYSTEM_MD` env var → tmp file | ❌ No |
| Codex | None — reads `AGENTS.md` from cwd | ✅ Yes |
| Copilot | None — reads `AGENTS.md` from cwd (ACP) | ✅ Yes |
| OpenCode | prompt argument | ❌ No |

### CLI's own built-in behavior (independent of cli-jaw)

| CLI | Auto-discovery | Walks up dirs? | Affected by ~/AGENTS.md? |
|-----|---------------|----------------|--------------------------|
| Claude CLI | Reads `CLAUDE.md`, `AGENTS.md` from cwd + parents | ✅ Yes | ✅ **Polluted** |
| Codex CLI | Reads `AGENTS.md` from cwd + parents | ✅ Yes | ✅ **Polluted** |
| Copilot CLI | Reads `AGENTS.md` from cwd + parents | ✅ Yes | ✅ **Polluted** |
| Gemini CLI | Uses `GEMINI_SYSTEM_MD` env only | ❌ No | ❌ Safe |
| OpenCode CLI | Uses `--prompt` arg | ❌ No | ❌ Safe |

---

## Smoke Test Results (2026-02-26)

Tested with `~/AGENTS.md` and `~/CLAUDE.md` **removed**, only `~/.cli-jaw/AGENTS.md` present.
Each CLI run from `cwd: ~/.cli-jaw` using the exact same method as `spawn.ts`.

| CLI | Model | Spawn Method | Identity | Skills | Employees | Result |
|-----|-------|-------------|----------|--------|-----------|--------|
| Claude | default | `--append-system-prompt "$(B.md)"` | ✅ Jaw Agent 🦈 | ✅ 17 | ✅ 4 | **PASS** |
| Codex | gpt-5.3-codex | `exec --skip-git-repo-check` (auto-reads AGENTS.md) | ✅ Jaw Agent | ✅ 17 | ✅ 4 | **PASS** |
| Copilot | gpt-5-mini | `-p` (reads AGENTS.md from cwd) | ✅ Jaw | ✅ 17 | ✅ 4 | **PASS** |
| Gemini | default | `GEMINI_SYSTEM_MD=/tmp/jaw-gemini-sys.md` | ✅ Jaw 🦈 | ✅ 17 | ✅ 4 | **PASS** |

### Key Findings
- `~/.cli-jaw` is a non-git dotfile directory — all 5 CLIs execute without errors
- Codex `exec` mode auto-reads `AGENTS.md` from cwd (previously uncertain)
- Codex uses `--skip-git-repo-check` (already in `args.ts:20`)
- No CLI requires `~/.cli-jaw` to be a git repo

---

## Proposed Change

Change default `workingDir` from `~/` to `~/.cli-jaw` (= `JAW_HOME`).

### Why This Fixes The Pollution

- `AGENTS.md` moves from `~/AGENTS.md` to `~/.cli-jaw/AGENTS.md`
- Hidden directory `.cli-jaw` is NOT traversed by CLI parent-directory walks
  (CLIs stop at repo root or home, they don't descend into dotfiles)
- Standalone `claude` in `~/Developer/my-app/` walks up → finds nothing → clean session
- cli-jaw spawn uses `cwd: ~/.cli-jaw` → finds `AGENTS.md` → works normally

### workingDir Change Strategy: Option A — Leave Old, Start Fresh

When a user changes `settings.workingDir` at runtime:
- New `AGENTS.md` is generated at the new path via `regenerateB()`
- Old path's `AGENTS.md` stays — no auto-delete, no migration

**Rationale:** Simple, no risk of data loss. Dotfile directories don't cause CLI pollution.

---

## UX: workingDir Runtime Management

### What Lives WHERE

```
~/.cli-jaw/  (JAW_HOME — fixed, never moves)
├── jaw.db              ← SQLite DB (conversations, sessions, memories)
├── settings.json       ← user config (includes workingDir path)
├── mcp.json            ← unified MCP server config
├── memory/MEMORY.md    ← persistent long-term memory
├── prompts/            ← A-1.md, A-2.md, B.md
├── skills/             ← installed skill definitions
├── skills_ref/         ← reference skills (87)
├── uploads/            ← media files
└── worklogs/           ← orchestration logs

{workingDir}/  (dynamic — user can change)
├── AGENTS.md           ← generated prompt (regenerateB)
├── CLAUDE.md           ← symlink → AGENTS.md
├── .mcp.json           ← Claude Code MCP config (syncToAll)
├── .agents/skills/     ← symlink → ~/.cli-jaw/skills/
└── .claude/skills/     ← symlink → ~/.cli-jaw/skills/
```

**Key insight:** JAW_HOME stores all persistent data. workingDir only holds
**generated/symlinked artifacts** that CLI tools need at their cwd.
So "move" is meaningless — there's nothing to move. Only "re-generate at new path."

### Decision Tree

```mermaid
flowchart TD
    A[User changes workingDir] --> B{New path exists?}
    B -->|No| C[mkdir -p newPath]
    B -->|Yes| C
    C --> D[Update settings.json]
    D --> E[regenerateB → AGENTS.md at new path]
    E --> F[ensureSkillsSymlinks at new path]
    F --> G[syncToAll MCP at new path]
    G --> H{Old path == JAW_HOME?}
    H -->|Yes| I[Nothing to clean — it's home]
    H -->|No| J{Old path is dotfile dir?}
    J -->|Yes| K[Leave it — no pollution risk]
    J -->|No| L[⚠️ Warn: old AGENTS.md may pollute]
    L --> M[Suggest manual cleanup]
```

### Why `move` Is Impractical

| Reason | Detail |
|--------|--------|
| Nothing to move | workingDir only has generated files (AGENTS.md, .mcp.json, symlinks) |
| Persistent data is fixed | jaw.db, memories, skills, prompts live at JAW_HOME permanently |
| Symlinks are path-specific | `.agents/skills/` symlinks point to `~/.cli-jaw/skills/` — must be re-created, not moved |
| Re-generation is instant | `regenerateB()` + `ensureSkillsSymlinks()` + `syncToAll()` takes <100ms |

### Why `copy` Is Also Unnecessary

Session memory at `~/.claude/projects/{hash}/memory/` is hashed from the workingDir
path. Changing workingDir means a new hash = new session memory space. The old session
memory stays untouched for Claude CLI to manage. cli-jaw's own persistent memory
(jaw.db, MEMORY.md) is at JAW_HOME — never affected by workingDir changes.

### Proposed CLI Command

```bash
cli-jaw workdir set /path/to/new/dir
```

**What it does (in order):**
1. Validate path (mkdir -p if needed)
2. Update `settings.json` → `workingDir: newPath`
3. Call `regenerateB()` → writes AGENTS.md + CLAUDE.md to new path
4. Call `ensureSkillsSymlinks(newPath)` → creates `.agents/skills/` symlink
5. Call `syncToAll(mcp, newPath)` → writes `.mcp.json` for Claude Code
6. Print summary + warn if old path had non-dotfile AGENTS.md

**No `move`, no `copy` needed.** Just set + regenerate.

---

## UX: Frontend Simplification

### Remove Permissions Toggle

Current UI has `🔒 Safe` / `⚡ Auto` toggle in sidebar settings.

**Problem with Safe mode:**
- Claude: removes `--dangerously-skip-permissions` → requires manual approval for every tool call
- Codex: removes `--dangerously-bypass-approvals-and-sandbox` → sandbox-only mode
- Copilot: passes `safe` to AcpClient → restricted permissions

**In practice:** Safe mode makes cli-jaw unusable as an autonomous agent.
CLI tools can't execute commands, read/write files, or use tools without manual
confirmation on each action — which defeats the entire purpose of cli-jaw.

**Decision:** Remove the permissions toggle from frontend. Hardcode `auto`.
Keep `settings.permissions` in config for API/power-user override if needed.

### Remove Working Directory Input

Current UI has a text input `<input id="inpCwd" value="~/">` in sidebar.

**Problem:** Free-text input with no validation. User types a path, but:
- No feedback on whether it's valid
- No regeneration of AGENTS.md/symlinks
- Easy to break by typo

**Decision:** Remove the text input. Working directory changes via:
- `cli-jaw workdir set /path` (CLI command — with full validation + regeneration)
- `cli-jaw init` (interactive wizard — guided setup)

### Frontend Changes

**`public/index.html`** — Remove from sidebar settings:
```html
<!-- REMOVE: permissions toggle -->
<div>
    <label data-i18n="label.permissions">권한</label>
    <div class="perm-toggle">
        <button class="perm-btn" id="permSafe">🔒 Safe</button>
        <button class="perm-btn active" id="permAuto">⚡ Auto</button>
    </div>
</div>

<!-- REMOVE: working directory input -->
<div>
    <label data-i18n="label.workingDir">작업 디렉토리</label>
    <input type="text" id="inpCwd" value="~/">
</div>
```

**`public/app.js` (or equivalent)** — Remove JS handlers for `permSafe`, `permAuto`, `inpCwd`.

---

## Affected Files & Diffs

### Phase 1: Core Defaults (PATCH-1 + PATCH-2 + PATCH-3)

**`src/core/config.ts:101`** — Default setting
```diff
-        workingDir: os.homedir(),
+        workingDir: JAW_HOME,
```

**`bin/commands/init.ts:46`** — Init wizard default
```diff
-    await ask('Working directory', settings.workingDir || os.homedir());
+    await ask('Working directory', settings.workingDir || path.join(os.homedir(), '.cli-jaw'));
```

**`src/prompt/builder.ts:210`** — A-2 default template
```diff
-- ~/
+- ~/.cli-jaw
```

**`bin/postinstall.ts:166-167`** — CLAUDE.md symlink target
```diff
-const agentsMd = path.join(home, 'AGENTS.md');
-const claudeMd = path.join(home, 'CLAUDE.md');
+const agentsMd = path.join(jawHome, 'AGENTS.md');
+const claudeMd = path.join(jawHome, 'CLAUDE.md');
```

### Phase 2: Frontend Cleanup (PATCH-4)

**`public/index.html`** — Remove permissions toggle + workingDir input
**`public/app.js`** (or related JS) — Remove corresponding event handlers

### Phase 3: CLI Command (PATCH-5) — Future

**`bin/commands/workdir.ts`** (new file) — `cli-jaw workdir set <path>`

### No change needed

| File | Why |
|------|-----|
| `src/prompt/builder.ts:547` (`regenerateB`) | Uses `settings.workingDir` — auto-follows |
| `src/agent/spawn.ts:465` | Uses `cwd: settings.workingDir` — auto-follows |
| `lib/mcp-sync.ts:226` (`ensureSkillsSymlinks`) | Takes `workingDir` param — auto-follows |

---

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Existing users with saved `workingDir: ~/` | None | `loadSettings()` merges; saved value wins |
| AGENTS.md path shifts | None | Smoke-tested — all 4 CLIs pass from `~/.cli-jaw` |
| Agent can't access `~/` | None | Full-permission mode; absolute paths work |
| Stale `~/AGENTS.md` from old default | Low | One-time manual cleanup or `cli-jaw init` prompt |
| Non-git directory | None | Codex `--skip-git-repo-check` already in place |
| Removing permissions toggle | None | Safe mode was unusable anyway; API override remains |
| Removing workdir input | None | CLI command provides better UX with validation |

## Migration

- **Existing users**: keep their persisted `workingDir` (no forced change)
- **New installs**: default to `~/.cli-jaw`
- **Upgrade path**: release notes suggest `rm ~/AGENTS.md ~/CLAUDE.md` once
- **Optional**: `cli-jaw init` detects old `~/AGENTS.md` and offers to clean up

---

## Implementation Order

- [ ] **Phase 1**: PATCH-1 + 2 + 3 (core defaults, 4 files, 5 lines) — do first, test
- [ ] **Phase 2**: PATCH-4 (frontend cleanup) — remove toggles
- [ ] **Phase 3**: PATCH-5 (`cli-jaw workdir set`) — future enhancement

---

## Source Validation Snapshot

Verified against source (2026-02-26, commit `8054549`):

- `src/core/config.ts:27` → `JAW_HOME = join(os.homedir(), '.cli-jaw')`
- `src/core/config.ts:101` → `workingDir: os.homedir()` ← PATCH-1
- `bin/commands/init.ts:46` → `settings.workingDir || os.homedir()` ← PATCH-1
- `src/prompt/builder.ts:210` → `- ~/` ← PATCH-2
- `bin/postinstall.ts:166-167` → `path.join(home, 'AGENTS.md')` ← PATCH-3
- `public/index.html:172-183` → permissions toggle + workdir input ← PATCH-4
- `src/prompt/builder.ts:547-548` → `join(settings.workingDir, 'AGENTS.md')` (no change)
- `src/agent/spawn.ts:465` → `cwd: settings.workingDir` (no change)
- `src/agent/args.ts:20` → `'--skip-git-repo-check'` (already in place)
