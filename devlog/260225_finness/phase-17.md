# Phase 17 — Triage AI 위임: regex 판단 → AI 자율 dispatch

> 문제: `needsOrchestration()` regex가 false → direct response 경로 → 에이전트가 subtask JSON 출력해도 무시됨
> 해결: AI한테 판단권 넘기기

---

## 현재 문제

```text
유저: "Phase 20 문서 검증해줘"
  → needsOrchestration("Phase 20 문서 검증해줘") → false (signal 1개: 길이 < 80)
  → direct response 경로 → copilot spawn
  → copilot: "직원한테 시킬게요!" + ```json { "subtasks": [...] } ```
  → stripSubtaskJSON() → JSON 제거 → 텍스트만 반환
  → 직원 dispatch 안 됨 ❌
```

`needsOrchestration()` 판단 기준 (현재):
- Signal 1: 길이 >= 80자
- Signal 2: 코드 키워드 (구현/수정/테스트...)
- Signal 3: 파일 경로 (src/, lib/...)
- Signal 4: 멀티태스크 (그리고/또한/동시에...)
- **2개 이상 signal → orchestration** / 아니면 → direct response

→ "Phase 20 검증해줘" 같은 짧은 메시지는 signal 1개밖에 안 잡혀서 무조건 direct.

---

## 해결: direct response에서 subtask JSON 감지 시 orchestration 재진입

### `orchestrator.js` L467-473 수정

```diff
 if (employees.length > 0 && !needsOrchestration(prompt)) {
     console.log(`[claw:triage] direct response (no orchestration needed)`);
     const { promise } = spawnAgent(prompt, { origin });
     const result = await promise;
+
+    // AI가 subtask JSON을 출력했으면 → orchestration으로 재진입
+    const subtasks = parseSubtasks(result.text);
+    if (subtasks?.length) {
+        console.log(`[claw:triage] agent chose orchestration (${subtasks.length} subtasks)`);
+        const worklog = createWorklog(prompt);
+        broadcast('worklog_created', { path: worklog.path });
+        const planText = stripSubtaskJSON(result.text);
+        appendToWorklog(worklog.path, 'Plan', planText);
+        const agentPhases = initAgentPhases(subtasks);
+        updateMatrix(worklog.path, agentPhases);
+        // Round loop 진입 (기존 L508~ 로직 재사용)
+        await executeRounds(agentPhases, worklog, { origin });
+        return;
+    }
+
     const stripped = stripSubtaskJSON(result.text);
     broadcast('orchestrate_done', { text: stripped || result.text || '', origin });
     return;
 }
```

### 핵심 원칙

**regex는 "힌트"만 제공, 최종 판단은 AI가 함.**
- `needsOrchestration()` = false여도, 에이전트가 JSON 출력하면 orchestration 진행
- `needsOrchestration()` = true여도, planning agent가 `direct_answer` 출력하면 direct response (이건 이미 구현됨 L492)

### 필요한 리팩터

`orchestrate()` 내 Round loop (L508-L552)을 `executeRounds()` 함수로 추출 → direct response 재진입 및 continue 경로에서 재사용.

---

## 구현 계획

| # | 작업 | 파일 |
|---|------|------|
| 1 | Round loop → `executeRounds()` 추출 | `orchestrator.js` |
| 2 | direct response에서 subtask 감지 → 재진입 | `orchestrator.js` |
| 3 | 기존 테스트 회귀 확인 | `npm test` |
| 4 | phase-17.md 커밋 | devlog |
