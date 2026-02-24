# Phase 17.3.1 — PHASE_PROFILES/INSTRUCTIONS 복원 (핫픽스)

> 원인: Phase 20 에이전트가 `orchestrator-parser.js` 추출 시 `PHASE_PROFILES` + `PHASE_INSTRUCTIONS` 동시 삭제
> 증상: `ReferenceError: PHASE_PROFILES is not defined` (orchestrator.js:26)

---

## 에러 스택

```
file:///Users/junny/Documents/BlogProject/cli-claw/src/orchestrator.js:26
        const fullProfile = PHASE_PROFILES[role] || [3];
                            ^
ReferenceError: PHASE_PROFILES is not defined
    at initAgentPhases (orchestrator.js:24)
    at orchestrate (orchestrator.js:423)
```

## 원인 분석

다른 에이전트가 `orchestrator.js` 500줄 초과 해결을 위해 파싱 함수를 `orchestrator-parser.js`로 추출:

```diff
- CONTINUE_PATTERNS, isContinueIntent()
- CODE_KEYWORDS, needsOrchestration()
- parseSubtasks(), parseDirectAnswer(), stripSubtaskJSON()
- parseVerdicts()
- PHASE_PROFILES      ← ❌ 이것도 같이 삭제됨 (파싱 함수 아님)
- PHASE_INSTRUCTIONS   ← ❌ 이것도 같이 삭제됨 (파싱 함수 아님)
```

`PHASE_PROFILES`는 `initAgentPhases()`에서, `PHASE_INSTRUCTIONS`는 `distributeByPhase()`에서 사용 → 둘 다 `orchestrator.js`에 필요.

## 수정

```diff
 const PHASES = { 1: '기획', 2: '기획검증', 3: '개발', 4: '디버깅', 5: '통합검증' };

+const PHASE_PROFILES = {
+    frontend: [1, 2, 3, 4, 5],
+    backend: [1, 2, 3, 4, 5],
+    data: [1, 2, 3, 4, 5],
+    docs: [1, 3, 5],
+    custom: [3],
+};
+
+const PHASE_INSTRUCTIONS = { 1: `[기획]...`, 2: `[기획검증]...`, ... };
```

## 커밋

`69f1015` — `[hotfix] Phase 17.3.1: PHASE_PROFILES/INSTRUCTIONS 복원`
