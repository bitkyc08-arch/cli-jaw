# Phase 5: Orchestration

## 5.0 — 프롬프트 시스템 + Employee 주입

하이브리드 프롬프트(Phase 3)에 employee 동적 삽입 통합.

### 구조

```
~/.cli-claw/prompts/
├── A-1.md    ← 코어 (불변)
├── A-2.md    ← 사용자 편집 (UI 모달)
└── B.md      ← getSystemPrompt() 결과 저장 (자동)
```

### `getSystemPrompt()` — 통합 함수

```js
function getSystemPrompt() {
    const a1 = readFileSync(A1_PATH, 'utf8');
    const a2 = readFileSync(A2_PATH, 'utf8');
    let prompt = a1 + '\n\n' + a2;

    // Employee 있으면 오케스트레이션 블록 추가
    const emps = getEmployees.all();
    if (emps.length > 0) {
        const list = emps.map(e =>
            `- "${e.name}" (CLI: ${e.cli}) — ${e.role || '범용'}`
        ).join('\n');
        const example = emps[0].name;
        prompt += '\n\n## Employees\n' + list;
        prompt += `\n\n## Dispatching\nJSON subtask로 작업 분배:\n\`\`\`json\n{"subtasks":[{"agent":"${example}","task":"작업 내용","priority":1}]}\n\`\`\``;
        prompt += '\n\n## Rules\n- 실행 가능한 요청 → JSON으로 분배\n- employee 이름 정확히 매칭\n- "결과 보고" 받으면 사용자에게 요약';
    }

    return prompt;
}
```

### `regenerateB()` — 파일 저장 (codex/opencode용)

```js
function regenerateB() {
    writeFileSync(B_PATH, getSystemPrompt());
}
```

### 호출 시점

| 이벤트                                           | 동작                          |
| ------------------------------------------------ | ----------------------------- |
| 서버 시작                                        | `regenerateB()`               |
| A-2 수정 (`PUT /api/prompt`)                     | `regenerateB()`               |
| Employee CRUD (`POST/PUT/DELETE /api/employees`) | `regenerateB()`               |
| Agent spawn (claude/gemini)                      | `getSystemPrompt()` 직접 전달 |
| Agent spawn (codex/opencode)                     | B.md symlink 자동 읽힘        |

### 체크리스트

- [ ] `getSystemPrompt()` 리팩터 (A-1 + A-2 + employees)
- [ ] `regenerateB()` = `writeFileSync(B_PATH, getSystemPrompt())`
- [ ] Employee CRUD 후 `regenerateB()` 호출 추가
- [ ] A-2 PUT 후 `regenerateB()` 호출 확인
- [ ] symlink 검증 (codex.md → B.md, AGENTS.md → B.md)

---

## 5.1 — spawnAgent 리팩터

```js
function spawnAgent(prompt, opts = {}) {
    // opts: { agentId, cli, model, effort, forceNew, sysPrompt }
    // forceNew=true → sub-agent (resume 금지, 커스텀 prompt)
    // forceNew=false → 기존 동작 (resume 허용)
    // return { child, promise }
}
```

- [ ] `spawnAgent(prompt)` → `spawnAgent(prompt, opts)` 시그니처 변경
- [ ] `forceNew` 분기 (resume 금지, activeProcess 무시)
- [ ] `promise` 반환 (close 시 resolve)

---

## 5.2 — parseSubtasks + distributeAndWait

```js
function parseSubtasks(text) {
    const match = text.match(/```json\n([\s\S]*?)\n```/);
    return match ? JSON.parse(match[1]).subtasks : null;
}

async function distributeAndWait(subtasks) {
    // 각 subtask → employee 매칭 → spawnAgent(forceNew=true) → 병렬 대기
}
```

- [ ] `parseSubtasks()` 구현
- [ ] `distributeAndWait()` 병렬 spawn + 결과 수집

---

## 5.3 — orchestrate 메인 루프

```js
async function orchestrate(prompt) {
    const emps = getEmployees.all();
    if (emps.length === 0) { spawnAgent(prompt); return; }

    // Round 1: Planning Agent → subtask 파싱
    // Loop: distribute → report → evaluate (max 3 rounds)
}
```

- [ ] `orchestrate()` 구현
- [ ] `/api/message` 라우트 → `orchestrate()` 호출로 변경
- [ ] WebSocket 이벤트 (round_start, subtask_distribute, round_done)
