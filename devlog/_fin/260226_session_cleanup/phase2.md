# Phase 2: 라운드 루프 — checkpoint 분기 + 세션 정리

## 대상 파일
- `src/orchestrator/pipeline.ts` — 메인 루프 (L338-376) + late-subtask 루프 (L255-287)

---

## 2-A. verdict 실패 로깅 (L338-348)

### 현재 코드

```typescript
// L338-348
if (verdicts?.verdicts) {
    for (const v of verdicts.verdicts) {
        const ap = agentPhases.find((a: Record<string, any>) => a.agent === v.agent);
        if (ap) {
            const judgedPhase = ap.currentPhase;
            advancePhase(ap, v.pass);
            ap.history.push({ round, phase: judgedPhase, pass: v.pass, feedback: v.feedback });
        }
    }
}
```

### Diff

```diff
 if (verdicts?.verdicts) {
     for (const v of verdicts.verdicts) {
         const ap = agentPhases.find((a: Record<string, any>) => a.agent === v.agent);
         if (ap) {
             const judgedPhase = ap.currentPhase;
             advancePhase(ap, v.pass);
             ap.history.push({ round, phase: judgedPhase, pass: v.pass, feedback: v.feedback });
         }
     }
+} else {
+    console.warn(`[jaw:review] verdict parse failed — skipping phase advance (round ${round})`);
 }
```

---

## 2-B. 완료 판정 — checkpoint 분기 (L351-361)

### 현재 코드

```typescript
// L351-361
const allDone = agentPhases.every((ap: Record<string, any>) => ap.completed);
if (allDone) {
    const summary = stripSubtaskJSON(rawText) || '모든 작업 완료';
    appendToWorklog(worklog.path, 'Final Summary', summary);
    updateWorklogStatus(worklog.path, 'done', round);
    clearAllEmployeeSessions.run();
    insertMessage.run('assistant', summary, 'orchestrator', '');
    broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin });
    break;
}
```

### Diff

```diff
-const allDone = agentPhases.every((ap: Record<string, any>) => ap.completed);
-if (allDone) {
-    const summary = stripSubtaskJSON(rawText) || '모든 작업 완료';
-    appendToWorklog(worklog.path, 'Final Summary', summary);
-    updateWorklogStatus(worklog.path, 'done', round);
-    clearAllEmployeeSessions.run();
-    insertMessage.run('assistant', summary, 'orchestrator', '');
-    broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin });
-    break;
-}
+const scopeDone = agentPhases.every((ap: Record<string, any>) => ap.completed)
+    || verdicts?.allDone === true;
+const hasCheckpoint = agentPhases.some((ap: Record<string, any>) => ap.checkpoint && !ap.checkpointed);
+
+if (scopeDone && hasCheckpoint) {
+    // CHECKPOINT: completed 마킹 안 함, 세션 보존
+    agentPhases.forEach((ap: Record<string, any>) => {
+        if (ap.checkpoint) ap.checkpointed = true;
+    });
+    updateMatrix(worklog.path, agentPhases);
+    const summary = stripSubtaskJSON(rawText) || '요청된 scope 완료';
+    appendToWorklog(worklog.path, 'Final Summary', summary);
+    updateWorklogStatus(worklog.path, 'checkpoint', round);
+    insertMessage.run('assistant', summary + '\n\n다음: "리뷰해봐", "이어서 해줘", "리셋해"', 'orchestrator', '');
+    broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin, checkpoint: true });
+    break;
+}
+
+if (scopeDone) {
+    // DONE: 진짜 완료
+    agentPhases.forEach((ap: Record<string, any>) => { ap.completed = true; });
+    updateMatrix(worklog.path, agentPhases);
+    const summary = stripSubtaskJSON(rawText) || '모든 작업 완료';
+    appendToWorklog(worklog.path, 'Final Summary', summary);
+    updateWorklogStatus(worklog.path, 'done', round);
+    clearAllEmployeeSessions.run();
+    insertMessage.run('assistant', summary, 'orchestrator', '');
+    broadcast('orchestrate_done', { text: summary, worklog: worklog.path, origin });
+    break;
+}
```

---

## 2-C. partial 경로 — 세션 보존 (L365-376)

### 현재 코드

```typescript
if (round === MAX_ROUNDS) {
    const done = agentPhases.filter((ap: Record<string, any>) => ap.completed);
    const pending = agentPhases.filter((ap: Record<string, any>) => !ap.completed);
    const partial = `## 완료 (${done.length})\n${done.map(...).join('\n')}\n\n` +
        `## 미완료 (${pending.length})\n${pending.map(...).join('\n')}\n\n` +
        `이어서 진행하려면 "이어서 해줘"라고 말씀하세요.\nWorklog: ${worklog.path}`;
    appendToWorklog(worklog.path, 'Final Summary', partial);
    updateWorklogStatus(worklog.path, 'partial', round);
    insertMessage.run('assistant', partial, 'orchestrator', '');
    broadcast('orchestrate_done', { text: partial, worklog: worklog.path, origin });
}
```

### Diff

```diff
 if (round === MAX_ROUNDS) {
     ...
     updateWorklogStatus(worklog.path, 'partial', round);
+    // partial: 세션 보존 (이어서 해줘 대비)
+    // 새 orchestrate() 진입 시 L228에서 자동 정리됨
     insertMessage.run('assistant', partial, 'orchestrator', '');
     broadcast('orchestrate_done', { text: partial, worklog: worklog.path, origin });
 }
```

> 여기에 `clearAllEmployeeSessions`를 넣지 **않는** 것이 핵심.
> 현재 코드도 없으므로 주석만 추가.

---

## 2-D. late-subtask 분기 (L255-287)

L331-376과 **동일 구조 복제**. 같은 diff 적용:
- L264 뒤: verdict 실패 로깅 (2-A와 동일)
- L266-274: checkpoint 분기 (2-B와 동일)
- L277-287: partial 세션 보존 주석 (2-C와 동일)

---

## 검증

```
CP-001: checkpoint=true → scopeDone → checkpointed=true, completed=false
CP-002: checkpoint=false → scopeDone → completed=true, clearSessions
CP-003: verdicts.allDone=true → scopeDone=true 작동
CP-004: parseVerdicts null → warn 로그 출력
CP-005: partial → clearSessions 미호출 확인
```
