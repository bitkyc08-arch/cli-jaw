# Working Directory Refactor — Default `~` -> `~/.cli-jaw`

**Date**: 2026-02-26
**Status**: Plan + Source Validation Complete (NO CODE)
**Priority**: Medium (UX/cleanliness)

---

## Problem

Current defaults use `~/` (user home) as the working directory.
That means:

1. `AGENTS.md` is generated into home by default (`settings.workingDir` fallback path)
2. Agent process `cwd` starts at `~/`
3. A-2 template says `Working Directory: ~/`
4. With full permissions, `~/` access is possible regardless of start cwd

Defaulting to `~/.cli-jaw` is cleaner and keeps system files in one place.

## Proposed Change

Change default `workingDir` from `~/` to `~/.cli-jaw`.

### Why `~/.cli-jaw` (not `~/cli-jaw`)

- Existing system home already uses `~/.cli-jaw`
- Config/prompts/skills already live under this root
- Default AGENTS generation lands in `~/.cli-jaw/AGENTS.md` (cleaner than home root)
- Start cwd becomes project-scoped while preserving full absolute-path access

---

## Affected Files & Diffs

1. `PATCH-1_default_workdir.md` (2 files)
2. `PATCH-2_a2_template.md` (1 file)
3. `PATCH-3_readme_note.md` (3 docs files, note-only)

---

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Existing users with saved `workingDir` | None | `loadSettings()` merges defaults with existing `settings.json`; saved value wins |
| AGENTS.md generation path shifts with new default | Low | CLIs read AGENTS.md in process cwd; cwd follows `settings.workingDir` |
| Agent home access reduced | None | Full-permission mode + absolute paths still allow `~/...` access |
| Init prompt default changes | Low | Prompt default only; user can override |

## Migration

- No migration required
- Existing users keep their persisted `settings.workingDir`
- New installs and first-run init prompt use the new default

---

## Source Validation Snapshot

Checked against current source (2026-02-26):

- `src/core/config.ts:101` -> `workingDir: os.homedir()` (to be patched)
- `bin/commands/init.ts:45-46` -> init default uses `settings.workingDir || os.homedir()` (to be patched)
- `src/prompt/builder.ts:194-211` -> `A2_DEFAULT` has `- ~/` (to be patched)
- `src/prompt/builder.ts:547-548` -> AGENTS is written to `join(settings.workingDir || os.homedir(), 'AGENTS.md')`
- `src/agent/spawn.ts:465` -> CLI spawn uses `cwd: settings.workingDir`
