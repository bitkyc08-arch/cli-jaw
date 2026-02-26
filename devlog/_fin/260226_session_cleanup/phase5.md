# Phase 5: Worklog ⏸ 기호 + Prompt 스키마

## 대상 파일
- `src/memory/worklog.ts` — `updateMatrix` (L114-115) + `parseWorklogPending` (L158)
- `src/orchestrator/pipeline.ts` — `phaseReview` prompt (L200-215)
- `src/orchestrator/distribute.ts` — `buildPlanPrompt` (L157, L221)

---

## 5-A. worklog.ts updateMatrix (L114-115)

### 현재 코드

```typescript
const table = agentPhases.map((ap: Record<string, any>) =>
    `| ${ap.agent} | ${ap.role} | Phase ${ap.currentPhase}: ${(PHASES as Record<string, string>)[ap.currentPhase] || '?'} | ${ap.completed ? '✅ 완료' : '⏳ 진행 중'} |`
).join('\n');
```

### Diff

```diff
 const table = agentPhases.map((ap: Record<string, any>) =>
-    `| ${ap.agent} | ${ap.role} | Phase ${ap.currentPhase}: ${(PHASES as Record<string, string>)[ap.currentPhase] || '?'} | ${ap.completed ? '✅ 완료' : '⏳ 진행 중'} |`
+    `| ${ap.agent} | ${ap.role} | Phase ${ap.currentPhase}: ${(PHASES as Record<string, string>)[ap.currentPhase] || '?'} | ${ap.completed ? '✅ 완료' : ap.checkpointed ? '⏸ checkpoint' : '⏳ 진행 중'} |`
 ).join('\n');
```

---

## 5-B. worklog.ts parseWorklogPending (L158)

### 현재 코드

```typescript
if (inMatrix && line.includes('⏳')) {
```

### Diff

```diff
-if (inMatrix && line.includes('⏳')) {
+if (inMatrix && (line.includes('⏳') || line.includes('⏸'))) {
```

---

## 5-C. pipeline.ts phaseReview prompt (L200-215)

### 현재 코드 (L200-202)

```typescript
### 판정 규칙
- **PASS**: 해당 phase의 필수 항목 모두 충족. 구체적 근거 제시.
- **FAIL**: 필수 항목 중 하나라도 미충족. **구체적 수정 지시** 제공 ("더 노력하세요" 금지, 구체적 행동 제시).
```

### Diff

```diff
 ### 판정 규칙
 - **PASS**: 해당 phase의 필수 항목 모두 충족. 구체적 근거 제시.
 - **FAIL**: 필수 항목 중 하나라도 미충족. **구체적 수정 지시** 제공 ("더 노력하세요" 금지, 구체적 행동 제시).
 
+### allDone 조기 완료 규칙
+- 모든 agent가 마지막 phase를 PASS하면 당연히 allDone: true.
+- **조기 완료 가능**: 커밋+테스트+푸시 완료 → 남은 phase가 있어도 allDone: true.
+- 판단 기준: 사용자의 원래 요청이 충족되었는가? 남은 phase가 실질적 가치를 추가하는가?
+
```

---

## 5-D. distribute.ts buildPlanPrompt (L157-160)

### 현재 코드 (L157-160)

```typescript
#### start_phase Selection
- You completed planning → start_phase = 3 (coding onwards)
- Code exists, only tests needed → start_phase = 4 (debugging onwards)
- Analysis required from scratch → start_phase = 1 (full delegation)
```

### Diff

```diff
 #### start_phase Selection
 - You completed planning → start_phase = 3 (coding onwards)
 - Code exists, only tests needed → start_phase = 4 (debugging onwards)
 - Analysis required from scratch → start_phase = 1 (full delegation)
+
+#### end_phase Selection (optional, default: role의 마지막 phase)
+- 간단한 수정/버그픽스 → end_phase: 3
+- 테스트까지 → end_phase: 4
+- 전체 → end_phase: 5 또는 생략
+- docs role은 [1,3,5]만 존재. end_phase: 2는 3으로 보정됨.
+
+#### checkpoint (optional, default: false)
+- true: scope 완료 후 유저에게 보고하고 대기
+- false: 자동으로 done 처리
```

### distribute.ts subtask JSON (L221)

```diff
     {
       "agent": "ExactAgentName",
       "role": "frontend|backend|data|docs",
       "task": "Specific instruction...",
       "start_phase": 3,
+      "end_phase": 3,
+      "checkpoint": true,
       "parallel": false,
       "verification": {
```

---

## 검증

```
WL-001: checkpoint 시 matrix에 ⏸ 표기 확인
WL-002: parseWorklogPending이 ⏸ 항목 감지
WL-003: ⏳ 항목도 여전히 감지 (기존 동작)
PR-001: review prompt에 allDone 규칙 포함 확인
DS-001: buildPlanPrompt에 end_phase/checkpoint 가이드 포함
DS-002: subtask JSON에 end_phase/checkpoint 필드 포함
```
