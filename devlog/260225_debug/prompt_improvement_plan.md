# Prompt Architecture Improvement Plan — Strong Prompt Engineering

> Goal: Transform cli-claw's prompt system from "functional instructions" into a **competitive, secretary-grade AI architecture** that outperforms default CLI system prompts.
> Files: `src/prompt/builder.ts`, `src/orchestrator/pipeline.ts`
> Devlog docs: `devlog/str_func/prompt_basic_A1.md`, `prompt_basic_A2.md`, `prompt_basic_B.md`

---

## Executive Summary

The current prompt system is **mechanically correct but strategically weak**. It tells the agent WHAT tools exist and HOW to use them, but fails at three critical layers:

1. **Identity Layer** — The agent has no personality architecture beyond "Friendly, warm"
2. **Intelligence Layer** — The agent is reactive (wait → do), not proactive (anticipate → suggest → do)
3. **Delegation Layer** — Employee prompts lack domain expertise framing and role identity

This plan addresses 7 improvements across these three layers. Each improvement includes the specific code location, before/after diff concept, and verification criteria.

---

## Analysis: Why Current Prompts Lose to CLI Defaults

### What CLI system prompts (Claude Code, Codex, Copilot CLI) do well:
- **Structured reasoning patterns**: "Think step by step", "Plan before executing"
- **Error recovery**: "If the first approach fails, try alternatives"
- **Conciseness rules**: "Be concise", "Minimize response length"
- **Safety guardrails**: Detailed permission models
- **Tool usage strategy**: Priority ordering, parallelization hints

### What cli-claw does better:
- **Multi-agent orchestration** (no CLI has this)
- **Persistent memory** across sessions
- **Heartbeat automation**
- **Skill system** for extensibility

### What cli-claw does poorly:
- **No reasoning framework** — agents don't plan before acting
- **No error recovery pattern** — if something fails, no fallback guidance
- **Vibe is cosmetic** — 2 lines can't encode a real personality
- **Employee prompts are generic** — a "Backend" agent gets the same framing as "Frontend"
- **No intent classification** — every message gets the same processing weight

---

## Improvement 1: A2 Vibe Section — Personality Architecture

### Problem
Current `A2_DEFAULT` Vibe section:
```markdown
## Vibe
- Friendly, warm
- Technically accurate
```
This is 2 attributes, not a personality. Real persona encoding (like 미소녀) needs 5-8 rules covering: tone, formality, emoji usage, response patterns, emotional intelligence, and boundary definitions.

### Solution
Expand A2_DEFAULT with rich commented examples that teach users HOW to customize personality.

### Code Change: `builder.ts` → `A2_DEFAULT` constant (line 194-211)

**Before:**
```markdown
## Vibe
- Friendly, warm
- Technically accurate
```

**After:**
```markdown
## Vibe
<!-- Personality architecture: define HOW the agent communicates -->
<!-- Tone: overall communication style -->
- Friendly, warm
- Technically accurate
<!-- Response style: length and structure preferences -->
- Concise by default; detailed when explaining complex topics
- Use bullet points for multi-step answers
<!-- Emotional intelligence: how to handle user frustration/excitement -->
- Acknowledge user emotions before jumping to solutions
- Celebrate wins with the user (e.g., "Nice!" when a build succeeds)
<!-- Language patterns (customize these for your language/culture) -->
<!-- Examples for Korean: 존댓말, ~요/~네요 endings, 이모지 적극 사용 -->
<!-- Examples for English: casual tone, contractions OK, minimal emoji -->
<!-- Boundaries: what the agent should NOT do in terms of tone -->
- Never be sarcastic or dismissive
- Never apologize excessively; just fix the problem
```

### Why This Matters
- HTML comments are **invisible to the agent** but visible to the user editing A-2.md
- Users see a template with categories they can fill in
- The actual prompt only contains the non-comment lines
- This turns A2 from "fill in 2 adjectives" into "design a personality"

### Verification
- [ ] A2_DEFAULT renders correctly (comments stripped by markdown)
- [ ] Existing user A-2.md files are NOT overwritten (file-exists check)
- [ ] New installations get the enriched template

---

## Improvement 2: Session Memory Injection — Transparent Scheduling

### Problem
```typescript
const injectInterval = Math.ceil(threshold / 2);
const shouldInject = memoryFlushCounter % injectInterval === 0;
```
This is clear in code but **opaque in documentation**. The devlog says `counter % ⌈threshold/2⌉ === 0` without explaining what this means in practice.

### Solution
Add inline comments in code + update devlog with concrete examples.

### Code Change: `builder.ts` lines 279-298

**Before:**
```typescript
// Auto-flush memories (threshold-based injection)
// Inject every ceil(threshold/2) messages: threshold=5 → inject at 0,3,5,8,10...
```

**After:**
```typescript
// ─── Session Memory Injection ────────────────────────
// Strategy: inject recent session memories periodically to maintain context
// without bloating every prompt.
//
// Schedule (based on settings.memory.flushEvery):
//   flushEvery=10  → inject every 5 messages  (messages 0, 5, 10, 15...)
//   flushEvery=20  → inject every 10 messages (messages 0, 10, 20, 30...)
//   flushEvery=5   → inject every 3 messages  (messages 0, 3, 5, 8, 10...)
//
// Memory is also flushed to disk at flushEvery interval (separate from injection).
// Injection loads from: ~/.claude/projects/{hash}/memory/ (10,000 char budget)
```

### Devlog Change: `prompt_basic_A1.md` line 89 and `prompt_basic_B.md` line 19

Replace the formula with a concrete table:

```markdown
| flushEvery (설정값) | Inject Interval | Inject at Messages | Flush to Disk |
|---|---|---|---|
| 5 | 3 | 0, 3, 5, 8, 10... | 5, 10, 15... |
| 10 | 5 | 0, 5, 10, 15... | 10, 20, 30... |
| 20 (default) | 10 | 0, 10, 20, 30... | 20, 40, 60... |
```

### Verification
- [ ] Comments in code match actual behavior
- [ ] Devlog tables are accurate (cross-reference with spawn.ts counter logic)

---

## Improvement 3: V1/V2 Employee Prompt Relationship — Explicit Hierarchy

### Problem
- `getEmployeePrompt()` (V1) is exported but **never called externally**
- Only `getEmployeePromptV2()` calls it as a base builder
- This causes confusion: "Is V1 standalone? Is it deprecated?"

### Solution
1. Mark V1 as `@internal` (JSDoc)
2. Rename conceptually: V1 = "base builder", V2 = "phase-aware wrapper"
3. Add clear comments explaining the relationship

### Code Change: `builder.ts` lines 420-477

**Before:**
```typescript
// ─── Employee Prompt (orchestration-free) ────────────

export function getEmployeePrompt(emp: any) {
```

**After:**
```typescript
// ─── Employee Prompt Base Builder ────────────────────
// This is the foundation layer for all employee prompts.
// It provides: identity, rules, browser, telegram, skills, memory, and completion protocol.
//
// Call hierarchy:
//   getEmployeePromptV2(emp, role, phase)  ← EXTERNAL (used by pipeline.ts)
//     └── getEmployeePrompt(emp)           ← INTERNAL (base builder only)
//
// @internal — Do not call directly from outside builder.ts.
//             Use getEmployeePromptV2() instead.

export function getEmployeePrompt(emp: any) {
```

> Note: We keep `export` because removing it would be a breaking change. The JSDoc `@internal` + comment is sufficient to signal intent.

### Devlog Change: `prompt_basic_B.md` line 66-78

Add clarification:
```markdown
### Employee Prompt Architecture

V1 (`getEmployeePrompt`) and V2 (`getEmployeePromptV2`) are NOT alternatives.
They form a **layered hierarchy**:

- **V1 (Base)**: Core identity + rules + tools. Called ONLY by V2 internally.
- **V2 (Phase-Aware)**: V1 + dev skills + phase context + quality gates. Called by pipeline.ts.

V1 is not deprecated — it's the foundation. V2 extends it.
No external code should call V1 directly (use V2).
```

### Verification
- [ ] No external imports of `getEmployeePrompt` exist (only `getEmployeePromptV2`)
- [ ] JSDoc appears in IDE hover tooltips

---

## Improvement 4: Line Number References → Symbol References

### Problem
Devlog documents reference source code by line numbers:
```
builder.ts L87–172, L251, L259–278, L280–293, L296–325...
pipeline.ts L112–185, L395–449...
```
These break on ANY code edit. There are ~28 line references across 3 devlog files.

### Solution
Replace ALL line references with **symbol-based references** (function names, constant names).

### Changes (documentation only — no code changes)

| File | Before | After |
|---|---|---|
| `prompt_basic_A1.md:4` | `L87–172` | `A1_CONTENT constant` |
| `prompt_basic_A1.md:15` | `builder.ts L251` | `getSystemPrompt() → A1 loading block` |
| `prompt_basic_A1.md:16` | `builder.ts L252` | `getSystemPrompt() → fs.existsSync(A1_PATH) ternary` |
| `prompt_basic_A1.md:87-94` | `L259–278`, `L280–293`, etc. | Function names + section comments |
| `prompt_basic_A2.md:4` | `L174–191` | `A2_DEFAULT constant` |
| `prompt_basic_B.md:1-3` | `L502–523` | `regenerateB() function` |
| `prompt_basic_B.md:16` | `L250–396` | `getSystemPrompt() function body` |
| `prompt_basic_B.md:54` | `L296–325` | `getSystemPrompt() → Orchestration section` |
| `prompt_basic_B.md:66` | `L395–449` | `getEmployeePrompt() function` |
| `prompt_basic_B.md:79` | `L442–498` | `getEmployeePromptV2() function` |

### Verification
- [ ] Zero `L<number>` references remain in devlog files
- [ ] All symbol references resolve to actual code symbols (grep verification)

---

## Improvement 5: Employee Role Identity — Domain Expert Framing

### Problem
Current employee prompt (V1) says:
```
# Frontend
Role: frontend
```
This is a label, not an identity. The agent has no context about WHY it was chosen or what makes it special. Compare to how a real VP delegates to a specialist:

> "You're our frontend expert. You understand component architecture, CSS layout systems, and browser APIs better than anyone on the team. I'm giving you this task because it requires your specific expertise."

### Solution
Add a **role identity block** to `getEmployeePromptV2()` that frames the agent as a domain expert.

### Code Change: `builder.ts` → `getEmployeePromptV2()` (after line 483)

**Add after `let prompt = getEmployeePrompt(emp);`:**

```typescript
// ─── Role Identity Framing
// Give the agent expert-level self-concept for their domain
const ROLE_IDENTITY: Record<string, string> = {
    frontend: `You are a frontend specialist. Your expertise: UI/UX implementation, component architecture, CSS systems, accessibility, browser APIs, and responsive design. You think in terms of user experience and visual consistency. When reviewing code, you prioritize: render performance, accessibility (a11y), and cross-browser compatibility.`,
    backend: `You are a backend specialist. Your expertise: API design, database optimization, server architecture, authentication/authorization, error handling, and system security. You think in terms of data flow, scalability, and reliability. When reviewing code, you prioritize: input validation, error boundaries, and data integrity.`,
    data: `You are a data engineering specialist. Your expertise: data pipelines, ETL processes, database schema design, query optimization, data validation, and ML integration. You think in terms of data quality, processing efficiency, and reproducibility. When reviewing code, you prioritize: data integrity, idempotency, and schema evolution.`,
    docs: `You are a documentation specialist. Your expertise: technical writing, API documentation, user guides, architecture diagrams, and changelog management. You think in terms of clarity, completeness, and discoverability. When reviewing docs, you prioritize: accuracy, examples, and maintainability.`,
};
const identity = ROLE_IDENTITY[role];
if (identity) {
    prompt += `\n\n## Your Expertise\n${identity}`;
}
```

### Why This Matters
Research on LLM prompting shows that **self-concept framing** ("You are an expert in X") significantly improves output quality in that domain. The current prompt treats all employees as generic "developers" — this is leaving performance on the table.

### Verification
- [ ] Each role (frontend/backend/data/docs) gets its identity block
- [ ] `custom` role gracefully skips the identity block
- [ ] Identity text stays under 100 words per role (token efficiency)

---

## Improvement 6: Secretary Intelligence Layer — Proactive Behaviors

### Problem
The current A1 prompt is a **tool manual**: "Here are your tools, here's how to use them." It never teaches the agent HOW to think. Compare:

| Aspect | Current (Tool Manual) | Proposed (Secretary Intelligence) |
|---|---|---|
| **Planning** | (none) | "Before executing multi-step tasks, outline your plan" |
| **Error Recovery** | (none) | "If an approach fails, try alternatives before giving up" |
| **Intent Disambiguation** | "Ask for clarification when ambiguous" | "When a request is ambiguous, state your assumption and proceed (don't block)" |
| **Priority Awareness** | (none) | "Identify the most critical sub-task and do it first" |
| **Progress Reporting** | (none) | "For tasks taking >3 steps, show progress between steps" |

### Solution
Add a **Thinking Patterns** section to A1_CONTENT, positioned AFTER Rules and BEFORE Browser Control.

### Code Change: `builder.ts` → `A1_CONTENT` (after line 99, before line 101)

**Insert new section:**

```markdown
## Thinking Patterns
- Before multi-step tasks: briefly state your plan (1-3 lines, not a full document)
- When a request is ambiguous: state your assumption, execute, and note what you assumed
- If an approach fails: try at least one alternative before reporting failure
- For tasks with 3+ steps: show brief progress between steps
- When you discover something unexpected: report it immediately, don't bury it in output
- Prioritize: correctness first, then completeness, then polish
```

### Why This Matters
This is the single most impactful change. CLI system prompts from Claude Code and Codex both include reasoning/planning instructions. cli-claw currently has ZERO guidance on HOW to think — only WHAT tools to use. Adding 6 lines of thinking patterns will measurably improve:
- Task completion rate (planning reduces errors)
- User trust (assumptions are stated, not hidden)
- Error recovery (alternatives are tried)
- Transparency (progress is shown)

### Verification
- [ ] New section appears in regenerated B.md
- [ ] Existing A-1.md files are not affected (file-priority system)
- [ ] Section is <100 words (token-efficient)

---

## Improvement 7: Orchestration Prompt — Concrete Delegation Criteria

### Problem
The planning prompt's tier classification is subjective:
```
### 🟡 Tier 1: 부분 위임 (직원 1~2명, 호출 2~3회)
- 중간 복잡도: 특정 영역 리팩토링, 기능 추가, 테스트 작성 등
```
"중간 복잡도" means different things to different models. No concrete metrics.

### Solution
Add **measurable criteria** to each tier in `pipeline.ts`.

### Code Change: `pipeline.ts` → `phasePlan()` (lines 112-188)

**Replace tier descriptions with concrete signals:**

```markdown
### 🟢 Tier 0: 직접 응답 (직원 호출 0회)
Signals: single file mentioned, question-type request, config change, <3 files affected
Examples: "fix this typo", "what does this function do?", "update the port number"

### 🟡 Tier 1: 부분 위임 (직원 1~2명)
Signals: 3-10 files affected, single domain (only frontend OR only backend), clear scope
Examples: "refactor the auth module", "add dark mode", "write tests for UserService"
Rule: YOU do the planning (analysis + file list + approach). Employee does coding + testing.

### 🔴 Tier 2: 전체 위임 (직원 2~4명)
Signals: 10+ files, cross-domain (frontend + backend), new feature requiring design
Examples: "build a settings page with API", "migrate database schema + update UI"
Rule: Each employee gets a non-overlapping file set. NEVER assign the same file to 2 agents.
```

### Additional: Task Instruction Quality Guide

Add after the tier section:

```markdown
## 좋은 지시 vs 나쁜 지시
❌ Bad: "프론트엔드 만들어" (too vague — what component? what design?)
✅ Good: "src/components/Settings.tsx 생성. props: { theme, onSave }. Tailwind CSS 사용. 다크모드 토글 포함."

❌ Bad: "백엔드 API 추가" (which endpoint? what schema?)  
✅ Good: "POST /api/settings 엔드포인트 추가. Body: { theme: string, locale: string }. DB: settings 테이블에 upsert."

Rule: Every task instruction must include: (1) specific files, (2) expected behavior, (3) constraints.
```

### Verification
- [ ] Planning agent can distinguish Tier 0/1/2 based on concrete signals
- [ ] Task instructions include file paths and behavioral specs
- [ ] No two employees receive overlapping file assignments

---

## Implementation Order

| Priority | Improvement | Type | Risk | Impact |
|:---:|---|---|---|---|
| **P0** | #6 Thinking Patterns | A1 code | Low (additive) | ⭐⭐⭐⭐⭐ |
| **P0** | #5 Role Identity | V2 code | Low (additive) | ⭐⭐⭐⭐ |
| **P1** | #1 Vibe Architecture | A2 code | Low (default only) | ⭐⭐⭐⭐ |
| **P1** | #7 Delegation Criteria | Pipeline code | Low (prompt text) | ⭐⭐⭐⭐ |
| **P2** | #3 V1/V2 Hierarchy | Code comments | Zero | ⭐⭐⭐ |
| **P2** | #2 Memory Injection Docs | Code comments + devlog | Zero | ⭐⭐ |
| **P3** | #4 Line References | Devlog only | Zero | ⭐⭐ |

### Token Budget Analysis

| Change | Added Tokens (est.) | Justification |
|---|---|---|
| Thinking Patterns | ~80 tokens | 6 lines, always injected — high ROI |
| Role Identity | ~60 tokens | Per-employee, conditional — worth it |
| Vibe Template | ~0 tokens* | HTML comments stripped from prompt |
| Delegation Criteria | ~120 tokens | Planning prompt only (one-shot) |
| V1/V2 Comments | 0 tokens | Code comments only |
| Memory Docs | 0 tokens | Documentation only |
| Line References | 0 tokens | Documentation only |

\* Vibe template adds tokens only in the comments visible to users editing A-2.md. The actual prompt lines are similar length to the current default.

**Total prompt size increase: ~140 tokens for main prompt, ~60 per employee.**
Current B.md is ~4000-5000 tokens. This is a ~3% increase for a significant quality improvement.

---

## What Makes This "Stronger Than CLI System Prompts"

### 1. Thinking Patterns (no CLI has this well)
Claude Code says "be concise". Codex says "think step by step". cli-claw will say: "plan briefly, state assumptions, try alternatives, show progress." This is MORE specific and MORE actionable.

### 2. Role Identity (unique to multi-agent)
No CLI system prompt can do this — they're single-agent. cli-claw's employees get domain-expert framing that focuses their output quality.

### 3. Personality Architecture (user-customizable)
Other CLIs have hardcoded personalities. cli-claw lets users design their own persona through A-2.md with guided templates. This is a competitive moat.

### 4. Secretary Behaviors
"Report unexpected findings immediately", "prioritize correctness over completeness" — these are behaviors that make an AI feel like a competent assistant rather than a command executor.

### 5. Concrete Delegation
"10+ files = Tier 2" is measurable. "Medium complexity" is not. Better classification → fewer wasted agent invocations → faster results.

---

## Files to Modify

| File | Changes |
|---|---|
| `src/prompt/builder.ts` | #1 A2_DEFAULT, #2 memory comments, #3 V1/V2 comments, #5 role identity, #6 thinking patterns |
| `src/orchestrator/pipeline.ts` | #7 delegation criteria + task quality guide |
| `devlog/str_func/prompt_basic_A1.md` | #2 memory table, #4 line refs → symbols |
| `devlog/str_func/prompt_basic_A2.md` | #4 line refs → symbols |
| `devlog/str_func/prompt_basic_B.md` | #2 memory table, #3 V1/V2 clarification, #4 line refs → symbols |

---

## Non-Goals (Explicitly Out of Scope)

- ❌ A1 modularization (splitting into A1-browser, A1-dev, etc.) — decided against by user
- ❌ Changing the 5-phase pipeline structure — working well as-is
- ❌ Adding new orchestration features — this is prompt improvement only
- ❌ Changing how B.md is assembled — assembly logic is correct
- ❌ Modifying existing user A-1.md or A-2.md files — file-priority system protects them
