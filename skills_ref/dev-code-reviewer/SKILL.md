---
name: dev-code-reviewer
description: "Code review guide for all orchestrated sub-agents. Review process, quality thresholds, antipattern detection, giving/receiving feedback. Available to any agent regardless of role — read this SKILL.md when performing or receiving code reviews."
---

# Dev-Code-Reviewer — Code Review Guide

Systematic code review patterns for finding real issues, not bikeshedding.

## When to Activate

- Reviewing code changes (own or others')
- Receiving code review feedback
- Assessing code quality before merge
- Evaluating pull requests or diffs
- Pre-refactoring quality baseline check

---

## 1. Code Review Process

### Pre-Review Checklist

Before reviewing any code, verify:

- [ ] Build passes (no compile/type errors)
- [ ] Tests pass (all green)
- [ ] PR/diff description explains **what** changed and **why**
- [ ] Diff is reasonable size (<500 changed lines — split larger PRs)

### Review Order (by impact, not preference)

1. **Architecture** — Does the approach make sense? Right layer? Right abstraction? Is this the right place for this code?
2. **Correctness** — Logic errors, edge cases, off-by-one, null/undefined handling, error paths
3. **Security** — Input validation, injection risks, auth checks, secrets exposure
4. **Performance** — N+1 queries, unbounded collections, missing indexes, unnecessary computation
5. **Maintainability** — Naming, structure, complexity, test coverage, documentation
6. **Style** — Last priority. Don't bikeshed formatting when there are real issues.

### Review Mindset

- **Be specific.** "This could fail" → "This throws if `user` is null on line 42"
- **Suggest, don't demand.** Unless it's a security or correctness issue.
- **Explain why.** Not just "change X to Y" but "X causes N+1 queries because..."
- **Acknowledge good work.** If a complex problem is solved elegantly, say so briefly.

---

## 2. Quality Thresholds

Flag these during review:

| Issue | Threshold | Severity |
|-------|-----------|----------|
| Long function | >50 lines | Medium |
| Large file | >500 lines | Medium |
| God class | >20 methods | High |
| Too many parameters | >5 | Medium |
| Deep nesting | >4 levels | Medium |
| High cyclomatic complexity | >10 branches | High |
| Missing error handling | any unhandled async | High |
| Hardcoded secrets | API keys, passwords in source | **Critical** |
| SQL injection | string concatenation in queries | **Critical** |
| Debug statements | console.log, debugger left in | Low |
| TODO/FIXME | unresolved in production code | Low |
| TypeScript `any` | bypassing type safety | Medium |

### Review Verdict

| Indicator | Verdict | Action |
|-----------|---------|--------|
| No high/critical issues | ✅ Approve | Merge |
| ≤2 high issues, clearly fixable | 🔧 Approve with suggestions | Fix before merge |
| Multiple high issues | ⚠️ Request changes | Author must address |
| Any critical issue | 🚫 Block | Cannot merge until resolved |

---

## 3. Common Antipatterns

### Structural

| Pattern | Symptom | Fix |
|---------|---------|-----|
| God class | One class does everything | Split by single responsibility |
| Long method | Function does 5+ distinct things | Extract named helper functions |
| Deep nesting | 4+ levels of if/for/try | Guard clauses, early returns, extraction |
| Feature envy | Method uses another object's data more than its own | Move method to the data owner |
| Shotgun surgery | One change requires edits in 10+ files | Consolidate related logic |

### Logic

| Pattern | Symptom | Fix |
|---------|---------|-----|
| Boolean blindness | `doThing(true, false, true)` | Named options object or enum |
| Stringly typed | `status === 'actve'` (typo = silent bug) | Define enum or union type |
| Magic numbers | `if (retries > 3)` | Named constant: `MAX_RETRIES = 3` |
| Primitive obsession | Passing 5 related strings around | Create a data object/type |

### Security

| Pattern | Symptom | Fix |
|---------|---------|-----|
| SQL injection | String concatenation in queries | Parameterized queries / prepared statements |
| Hardcoded secrets | `apiKey = "sk-..."` in source | Environment variables or secret manager |
| Missing validation | Raw user input passed to logic | Schema validation at API boundary |
| Overpermission | Broad access when narrow suffices | Principle of least privilege |

### Performance

| Pattern | Symptom | Fix |
|---------|---------|-----|
| N+1 queries | Loop → query per item | Batch fetch with `WHERE IN (...)` |
| Unbounded collections | `.all()` without LIMIT | Always paginate or set max |
| Missing index | Slow repeated lookups on same column | Add database index |
| Premature optimization | Complex caching for 10 rows | Profile first, optimize second |

### Async

| Pattern | Symptom | Fix |
|---------|---------|-----|
| Floating promise | `doAsync()` without `await` | Always `await` or handle rejection |
| Callback hell | 4+ nested callbacks | Refactor to async/await |
| Missing timeout | External call can hang forever | Set timeout on all network calls |

---

## 4. Receiving Code Review

### The Response Pattern

When receiving review feedback:

1. **READ** — Complete feedback without reacting immediately
2. **UNDERSTAND** — Restate the technical requirement in your own words
3. **VERIFY** — Check the suggestion against codebase reality (does it apply here?)
4. **EVALUATE** — Is it technically sound for THIS codebase, not just in theory?
5. **RESPOND** — Technical acknowledgment or reasoned pushback
6. **IMPLEMENT** — One item at a time, test each change

### When to Push Back

Push back when:
- Suggestion breaks existing functionality (test it)
- Reviewer lacks full context of the current architecture
- Violates YAGNI — feature is unused (grep the codebase to verify)
- Technically incorrect for this technology stack
- Conflicts with established architectural decisions

**How:** Use technical reasoning. Reference working tests, existing code, or documented decisions. Never push back emotionally — always with evidence.

### Implementation Order (multi-item feedback)

1. **Clarify ALL unclear items FIRST** — don't implement based on partial understanding
2. Blocking issues (security, data loss, broken functionality)
3. Simple fixes (typos, missing imports, naming)
4. Complex fixes (refactoring, logic changes)
5. Test EACH fix individually. Verify no regressions after each.

### Acknowledging Feedback

```
✅ "Fixed. Changed X to use parameterized query."
✅ "Good catch — the null check was missing. Added guard on line 42."
✅ Just fix it and show the result in code.

❌ "You're absolutely right!"
❌ "Great point! Thanks for catching that!"
❌ Any performative agreement without verification
```

---

## 5. Requesting Code Review

### When to Request

| Situation | Priority |
|-----------|----------|
| Before merge to main | **Mandatory** |
| After major feature completion | **Mandatory** |
| Before large refactoring | **Mandatory** |
| After complex bug fix | Recommended |
| When stuck on approach | Recommended |
| Small config/docs changes | Skip unless impactful |

### How to Request

1. Ensure build passes and all tests are green
2. Identify the diff range (base commit → head commit)
3. Provide a summary: what was implemented, what it should do, areas to focus on
4. Keep the diff <500 lines. Split larger changes into reviewable chunks.

### Acting on Feedback

| Severity | Action |
|----------|--------|
| Critical | Fix immediately, re-request review |
| High | Fix before proceeding to next task |
| Medium | Fix before merge, can continue other work |
| Low | Note for later, apply if trivial |
| Style | Apply if trivial, otherwise defer to team conventions |
