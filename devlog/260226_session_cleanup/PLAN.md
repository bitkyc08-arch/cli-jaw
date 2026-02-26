# Session Cleanup & Early Completion Fix

## Date: 2026-02-26

## Problem
Agent(직원)가 작업 완료(커밋+테스트+푸시) 후에도 세션 메모리가 남아있어 다음 작업과 충돌.

## Root Cause (3 bugs)

### Bug 1: MAX_ROUNDS partial 경로 세션 미정리
- `pipeline.ts` line ~366: `round === MAX_ROUNDS` 도달 시 `clearAllEmployeeSessions.run()` 누락
- `allDone` 경로에서만 세션 정리됨 → partial 상태에서 세션 잔존

### Bug 2: allDone verdict 무시
- review agent가 `allDone: true` 반환해도 코드에서 무시
- `agentPhases.every(completed)` 만 체크 → verdict의 allDone 활용 안 함

### Bug 3: Phase 5단계 vs MAX_ROUNDS 3
- `PHASE_PROFILES.backend = [1,2,3,4,5]`
- 한 라운드에 한 phase만 advance → 3라운드로 5단계 완료 불가능
- 구조적 문제이나 allDone 조기완료로 우회

## Diff Summary

### pipeline.ts

```diff
 # Fix 1: allDone verdict 지원
-const allDone = agentPhases.every(ap => ap.completed);
+const allDone = agentPhases.every(ap => ap.completed) || verdicts?.allDone === true;
 if (allDone) {
+    agentPhases.forEach(ap => { ap.completed = true; });
+    updateMatrix(worklog.path, agentPhases);
     // ... 완료 처리 ...
 }

 # Fix 2: partial 경로 세션 정리 (2곳)
 if (round === MAX_ROUNDS) {
     // ... partial report ...
+    clearAllEmployeeSessions.run();  // ← 추가
     insertMessage.run('assistant', partial, ...);
 }

 # Fix 3: parseVerdicts 실패 로깅
 if (verdicts?.verdicts) {
     // ... advance logic ...
+} else {
+    console.warn(`[jaw:review] verdict parse failed ...`);
 }

 # Fix 4: review prompt — allDone 조기완료 권한
+### allDone 조기 완료 규칙
+- 커밋+테스트+푸시 완료 → 남은 phase 있어도 allDone: true 가능
+- 판단 기준: 사용자 요청이 충족되었는가?
```

## Future Improvement
- [ ] `PHASE_PROFILES`를 작업 유형별로 경량화 (예: simple fix → [3] only)
- [ ] planning agent에게 `start_phase` + `end_phase` 지정 권한 부여
- [ ] MAX_ROUNDS를 phase 수에 맞게 동적 계산

## Verification
- `npm test` — 기존 테스트 통과 확인
- 실제 직원 디스패치 후 세션 정리 확인 필요
