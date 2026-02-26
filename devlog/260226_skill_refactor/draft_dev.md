---
name: dev
description: "Common development guidelines for all orchestrated sub-agents. Enforces modular development, systematic debugging, verification-before-completion, change logging, and code quality standards. Always injected by orchestrator."
---

# Dev — Common Development Guidelines

Core rules applied to every sub-agent, regardless of role.

## Companion Skills

This skill covers universal guidelines. For domain-specific work, you **must** also consult the matching role skill — read its `SKILL.md` before writing any code in that domain:

| Skill File | Injected When | Covers |
|---|---|---|
| `dev-frontend/SKILL.md` | `role=frontend` | UI/UX implementation, design aesthetics, component architecture, responsive layouts, animation |
| `dev-backend/SKILL.md` | `role=backend` | API design, architecture patterns, database optimization, security, error handling, middleware |
| `dev-data/SKILL.md` | `role=data` | Data pipelines, ETL/ELT, data quality validation, SQL optimization, analysis & reporting |
| `dev-testing/SKILL.md` | `role=testing` or debugging phase | Playwright browser testing, test strategy, debugging patterns, coverage analysis |
| `dev-code-reviewer/SKILL.md` | Any agent, during code review | Review process, quality thresholds, antipattern detection, giving/receiving feedback |

**When your task spans multiple domains** (e.g., building an API endpoint that returns analyzed data), read ALL relevant skill files before starting.

---

## 1. Modular Development

Every file, function, and class must have a single, clear responsibility.

**Hard limits:**

| Metric | Threshold | Action |
|--------|-----------|--------|
| File length | >500 lines | Split into focused modules |
| Function length | >50 lines | Extract helper functions |
| Class methods | >20 methods | Split by responsibility |
| Nesting depth | >4 levels | Flatten with early returns or extraction |
| Function parameters | >5 | Use an options/config object |

**Rules:**
- ES Module (`import`/`export`) only. No CommonJS `require()`.
- One default export per file when the file has a primary purpose.
- Follow existing naming conventions in the project. Check sibling files before creating new ones.
- New files must match the directory structure and naming patterns already in use.

---

## 2. Systematic Debugging

Random fixes waste time and create new bugs. Follow this process for ANY technical issue — test failures, unexpected behavior, build errors, performance problems.

### Phase 1: Root Cause Investigation

**Before attempting any fix:**

1. **Read the full error message and stack trace.** Don't skip past them — they often contain the exact answer.
2. **Reproduce consistently.** What are the exact steps? Does it happen every time? If not, gather more data instead of guessing.
3. **Check recent changes.** `git diff`, recent commits, new dependencies, config changes, environment differences.
4. **Trace data flow.** Where does the bad value originate? Trace backward through the call stack until you find the source. Fix at the source, not the symptom.

### Phase 2: Pattern Analysis

1. Find working code in the same codebase that does something similar.
2. List every difference between working and broken — however small.
3. Don't assume "that can't matter."

### Phase 3: Hypothesis Testing

1. Form ONE clear hypothesis: "X is the root cause because Y."
2. Make the SMALLEST possible change to test it.
3. One variable at a time. Never fix multiple things at once.
4. Didn't work? Form a NEW hypothesis. Don't pile fixes on top.

### Phase 4: Implementation

1. Write a failing test that reproduces the bug.
2. Implement a single fix addressing the root cause.
3. Verify: test passes, no regressions, output is clean.

**If 3+ fix attempts fail:** Stop. The problem is likely architectural, not a simple bug. Discuss with your human partner before attempting more fixes.

**Red flags — stop and return to Phase 1:**
- "Quick fix for now, investigate later"
- "Just try changing X and see"
- "I don't fully understand but this might work"
- Proposing solutions before investigating

---

## 3. Verification Before Completion

Never claim work is complete without running verification. Evidence before assertions, always.

**The gate (mandatory before ANY completion claim):**

1. **IDENTIFY** — What command proves this claim?
2. **RUN** — Execute the full command (fresh, not cached).
3. **READ** — Full output. Check exit code. Count failures.
4. **VERIFY** — Does the output actually confirm the claim?
5. **Only then** — State the claim WITH evidence.

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| "Tests pass" | Test command output: 0 failures | Previous run, "should pass" |
| "Build succeeds" | Build command: exit 0 | "Linter passed" |
| "Bug fixed" | Original symptom verified resolved | "Code changed, assumed fixed" |
| "Feature complete" | Each requirement checked line-by-line | "Tests pass" |

**Red flags — you're about to lie:**
- Using words like "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Done!")
- Relying on partial verification or a previous run
- Thinking "just this once"

---

## 4. Change Documentation

When a worklog or changelog file is provided, record every change in this format:

```markdown
### [filename] — [reason for change]
- **Changes**: what was modified and why
- **Impact**: modules that import or depend on this file
- **Verification**: how the change was tested (command + result)
```

Keep entries factual and concise. One entry per file changed.

---

## 5. Safety Rules

- **Never delete existing exports** — other modules may depend on them. Deprecate first if needed.
- **Verify imports exist** before adding new `import` statements. Check the target file is real.
- **No hardcoded configuration** — use config files or environment variables. Magic strings and numbers belong in constants.
- **Error handling is mandatory** — `try/catch` for all async operations. No silent failures. At minimum, log the error with context (`console.error('[module]', error.message)`).
- **No destructive operations without confirmation** — deleting files, dropping tables, resetting state, or clearing caches require explicit user approval.

---

## 6. Code Quality Signals

Watch for these anti-patterns and fix immediately:

| Anti-Pattern | Symptom | Fix |
|---|---|---|
| **God class** | >20 methods, mixed responsibilities | Split by domain into focused classes |
| **Long method** | >50 lines, does multiple things | Extract into named helper functions |
| **Deep nesting** | >4 levels of if/for/try | Early returns, guard clauses, extract |
| **Magic numbers** | Hardcoded `86400`, `1024`, `3` | Named constants with clear intent |
| **Stringly typed** | Strings where enums/types belong | Define explicit types or enums |
| **Missing error handling** | No catch, no input validation | Add try/catch, validate all inputs |
| **Floating promises** | async call without `await` | Always `await` or handle rejection |
| **Copy-paste code** | Same logic in 2+ places | Extract shared function, import it |

**Good code reads like well-written prose:**
- Function names describe what they do (`calculateTotalPrice`, not `calc`)
- Variable names reveal intent (`remainingRetries`, not `r`)
- Comments explain WHY, not WHAT (the code shows what)
