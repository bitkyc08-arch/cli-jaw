# Phase 4 — AGENTS.md 자동 갱신 + 메모리 품질 개선

> 작성일: 2026-02-25
> 커밋: spawn.js + builder.js

---

## 문제

1. **AGENTS.md 갱신 안 됨**: A-1.md를 수정하거나 설정을 변경해도 에이전트 spawn 시 AGENTS.md가 stale
   - 원인: `regenerateB()`가 server.js의 특정 트리거에서만 호출 → spawn 전에 호출 안 됨
   - CLI(Codex/Copilot)는 디스크의 AGENTS.md를 읽음 → 오래된 내용 사용

2. **MEMORY.md에 개발 체크리스트 저장됨**: 에이전트가 25줄짜리 P0~P12 체크리스트를 Core Memory에 덤프
   - 프롬프트에 매번 주입 → 토큰 낭비 + 불필요한 컨텍스트
   - A1_CONTENT에 "무엇을 저장할지" 가이드라인 없었음

3. **A-1.md 축소 상태**: 에이전트가 A-1.md를 11줄로 축소 → Browser/Telegram/Memory/Heartbeat 섹션 누락
   - Phase 15에서 하드코딩 → 파일 무시 → 문제 인지 불가
   - 현재는 파일 우선 로딩이지만, 파일이 축소 상태

---

## 해결

### 1. spawn 시 자동 AGENTS.md 갱신 (`spawn.js`)

```diff
+import { getSystemPrompt, regenerateB } from '../prompt/builder.js';

 export function spawnAgent(prompt, opts = {}) {
+    // Ensure AGENTS.md on disk is fresh before CLI reads it
+    if (!opts.internal && !opts._isFallback) regenerateB();
```

- 매 spawn 전에 `regenerateB()` 호출 (internal/fallback 제외)
- A-1.md 수정 → 다음 spawn 시 자동 반영
- 이전: server.js 10곳에서만 호출 → spawn 시 stale 가능
- 이후: spawn마다 guaranteed fresh

### 2. Memory Save Quality Rules (`builder.js` A1_CONTENT)

```markdown
### What to Save (IMPORTANT)
- ✅ User preferences, key decisions, project facts
- ✅ Config changes, tool choices, architectural decisions
- ✅ Short 1-2 line entries
- ❌ Do NOT save development checklists or task lists
- ❌ Do NOT save commit hashes, phase logs, or progress tracking
- ❌ Do NOT dump raw conversation history into memory
```

### 3. MEMORY.md 정리

Before (25줄):
```
- 2026-02-25: 260225 Finness 개발노트. 체크리스트:
  - [x] P0 안정화...
  - [x] P1 정합성...
  ... (25줄 개발 로그)
```

After (15줄):
```
# Memory
## User Preferences
- Language: Korean, Agent: 미소녀, CLI: copilot
## Key Decisions
- ES Module only, 500줄 제한, Git 명시 요청만
## Active Projects
- cli-claw: AI Agent Orchestration Platform
```

### 4. A-1.md 복원

- 11줄 → 94줄 (A1_CONTENT 기본값 + Memory Save Rules)
- Browser Control, Telegram Bot-First, Memory, Heartbeat, Dev Rules 전부 복원

---

## 영향

| 항목 | Before | After |
|---|---|---|
| A-1.md 수정 후 반영 | 서버 재시작 필요 | **자동** (다음 spawn) |
| MEMORY.md 크기 | ~1400자 (dev checklist) | **~400자** (essentials) |
| AGENTS.md 섹션 | 12개 (A-1 누락) | **20개** (전체 포함) |
| Memory 저장 품질 | 가이드 없음 | ✅/❌ 명시 규칙 |
