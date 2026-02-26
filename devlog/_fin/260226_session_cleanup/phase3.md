# Phase 3: 세션 복원 + _skipClear

## 대상 파일
- `src/orchestrator/pipeline.ts` — L228, L244, L308 (clear 지점 3곳) + `orchestrateContinue` (L382-407)

---

## 3-A. _skipClear 적용 (3곳)

### L228 (orchestrate 진입)

```diff
 export async function orchestrate(prompt: string, meta: Record<string, any> = {}) {
-    clearAllEmployeeSessions.run();
+    if (!meta._skipClear) clearAllEmployeeSessions.run();
     clearPromptCache();
```

### L244 (late-subtask 분기 내 clear)

```diff
         if (lateSubtasks?.length) {
             console.log(`[jaw:triage] agent chose to dispatch (${lateSubtasks.length} subtasks)`);
             const worklog = createWorklog(prompt);
             broadcast('worklog_created', { path: worklog.path });
-            clearAllEmployeeSessions.run();
+            if (!meta._skipClear) clearAllEmployeeSessions.run();
```

### L308 확인

> L308 근처를 확인: 실제로 3번째 clear 지점이 있는지 라인 확인 필요.
> 현재 코드 기준 L228, L244가 확실한 2곳. L308은 직원 리뷰에서 지적한 곳으로,
> 실제 해당 라인에 clear가 있는지 구현 시 재확인.

---

## 3-B. orchestrateContinue 수정 (L382-407)

### 현재 코드

```typescript
export async function orchestrateContinue(meta: Record<string, any> = {}) {
    const origin = (meta as Record<string, any>).origin || 'web';
    const latest = readLatestWorklog();
    if (!latest) {
        broadcast('orchestrate_done', { text: '이어갈 worklog가 없습니다.', origin });
        return;
    }

    const pending = parseWorklogPending(latest.content);
    if (!pending.length) {
        broadcast('orchestrate_done', { text: '모든 작업이 이미 완료되었습니다.', origin });
        return;
    }

    const resumePrompt = `## 이어서 작업
이전 worklog를 읽고 미완료 항목을 이어서 진행하세요.

Worklog: ${latest.path}

미완료 항목:
${pending.map((p: Record<string, any>) => `- ${p.agent} (${p.role}): Phase ${p.currentPhase}`).join('\n')}

subtask JSON을 출력하세요.`;

    return orchestrate(resumePrompt, meta);
}
```

### Diff

```diff
 export async function orchestrateContinue(meta: Record<string, any> = {}) {
     const origin = (meta as Record<string, any>).origin || 'web';
     const latest = readLatestWorklog();
-    if (!latest) {
+    if (!latest || latest.content.includes('Status: done') || latest.content.includes('Status: reset')) {
         broadcast('orchestrate_done', { text: '이어갈 worklog가 없습니다.', origin });
         return;
     }

     const pending = parseWorklogPending(latest.content);
     if (!pending.length) {
         broadcast('orchestrate_done', { text: '모든 작업이 이미 완료되었습니다.', origin });
         return;
     }

     const resumePrompt = `## 이어서 작업
 ...
 subtask JSON을 출력하세요.`;

-    return orchestrate(resumePrompt, meta);
+    return orchestrate(resumePrompt, { ...meta, _skipClear: true });
 }
```

핵심: `_skipClear: true` → orchestrate 진입 시 `clearAllEmployeeSessions` 건너뜀 → 기존 세션 복원.

---

## 검증

```
SL-001: orchestrateContinue → orchestrate(_skipClear=true) → L228 clear 안 함
SL-002: orchestrateContinue → L244 clear 안 함
SL-003: 일반 orchestrate (meta 없음) → L228 clear 실행
SL-004: done worklog → continue 거부
SL-005: reset worklog → continue 거부
```
