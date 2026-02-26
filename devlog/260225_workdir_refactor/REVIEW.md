# Review — Workdir Refactor Plan Validation

**Date**: 2026-02-26  
**Scope**: Plan-only validation, no code changes

---

## Patch Verdicts

### PATCH-1_default_workdir.md
**Verdict**: APPROVE

- Targeted files are correct: `src/core/config.ts`, `bin/commands/init.ts`
- Existing users are safe: `loadSettings()` merges defaults with existing file values, so persisted `workingDir` remains unchanged.
- Import/export risk: none (`join` already imported in `config.ts`, `path` already imported in `init.ts`)

### PATCH-2_a2_template.md
**Verdict**: APPROVE

- Target file is correct: `src/prompt/builder.ts` (`A2_DEFAULT`)
- Scope is correct: only affects first creation of `A-2.md` (`if (!fs.existsSync(A2_PATH))`)
- Runtime behavior remains controlled by `settings.workingDir` in spawn path

### PATCH-3_readme_note.md
**Verdict**: APPROVE

- Docs alignment is necessary to avoid confusion after PATCH-1/2 rollout
- Must ship together with PATCH-1/2 to prevent temporary mismatch

---

## Required Source Checks (Verified)

1. `src/core/config.ts:101` -> default is `workingDir: os.homedir()`
2. `bin/commands/init.ts:45-46` -> init prompt default uses `settings.workingDir || os.homedir()`
3. `src/prompt/builder.ts:194-211` -> A2 template contains `Working Directory: ~/`
4. `src/prompt/builder.ts:541-548` -> `regenerateB()` writes `AGENTS.md` to `join(settings.workingDir || os.homedir(), 'AGENTS.md')`
5. `src/agent/spawn.ts:465` -> child process `cwd: settings.workingDir`

---

## Additional References Checked (No Missed Default Sources)

- `src/prompt/builder.ts:236` uses `settings.workingDir || os.homedir()` for session-memory path derivation (fallback only)
- No other default `workingDir` source was found outside PATCH-1 scope

---

## Edge Cases

1. Empty string `workingDir` in settings:
`settings.workingDir || ...` fallback behavior remains intact.

2. Non-existent directory path:
`regenerateB()` already wraps AGENTS write in `try/catch` and logs failure.

3. Existing users with `~/` explicitly configured:
No forced migration; behavior remains unchanged until user edits settings.

4. Full home access expectation:
Changing cwd default does not remove absolute path access to `~/...` when permissions allow.

5. Legacy `~/AGENTS.md` compatibility:
Postinstall symlink logic (`~/CLAUDE.md` -> `~/AGENTS.md` if present) remains independent and should be documented.

---

## Conclusion

Plan is feasible and safe as a default-only change.  
Recommended application order: **PATCH-1 -> PATCH-2 -> PATCH-3**.
