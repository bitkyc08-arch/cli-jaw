# Phase 1: end_phase 파싱 + sparse fallback

## 대상 파일
- `src/orchestrator/pipeline.ts` — `initAgentPhases()` (L40-74)

## 현재 코드 (L47-55)

```typescript
const rawStart = Number(st.start_phase);
const minPhase = fullProfile[0]!;
const maxPhase = fullProfile[fullProfile.length - 1]!;
const startPhase: number = Number.isFinite(rawStart)
    ? Math.max(minPhase, Math.min(maxPhase, rawStart))
    : minPhase;
const profile = fullProfile.filter((p: number) => p >= startPhase);
const effectiveProfile = profile.length > 0 ? profile : [fullProfile[fullProfile.length - 1]!];
```

## Diff

```diff
 const rawStart = Number(st.start_phase);
+const rawEnd = Number(st.end_phase);
 const minPhase = fullProfile[0]!;
 const maxPhase = fullProfile[fullProfile.length - 1]!;
 const startPhase: number = Number.isFinite(rawStart)
     ? Math.max(minPhase, Math.min(maxPhase, rawStart))
     : minPhase;
-const profile = fullProfile.filter((p: number) => p >= startPhase);
-const effectiveProfile = profile.length > 0 ? profile : [fullProfile[fullProfile.length - 1]!];
+const endPhase: number = Number.isFinite(rawEnd)
+    ? Math.max(startPhase, Math.min(maxPhase, rawEnd))
+    : maxPhase;
+const profile = fullProfile.filter((p: number) => p >= startPhase && p <= endPhase);
+// sparse fallback: 빈 profile이면 startPhase 이상 가장 가까운 phase 사용
+const effectiveProfile = profile.length > 0
+    ? profile
+    : [fullProfile.find((p: number) => p >= startPhase) || fullProfile[fullProfile.length - 1]!];
+if (profile.length === 0) {
+    console.warn(`[jaw:phase] ${st.agent}: no phases in [${startPhase},${endPhase}], fallback to [${effectiveProfile[0]}]`);
+}
```

## 현재 코드 (L61-72 return 객체)

```typescript
return {
    agent: st.agent,
    task: st.task,
    role,
    parallel: st.parallel === true,
    verification: st.verification || null,
    phaseProfile: effectiveProfile,
    currentPhaseIdx: 0,
    currentPhase: effectiveProfile[0],
    completed: false,
    history: [] as Record<string, any>[],
};
```

## Diff

```diff
 return {
     agent: st.agent,
     task: st.task,
     role,
     parallel: st.parallel === true,
+    checkpoint: st.checkpoint === true,
+    checkpointed: false,
     verification: st.verification || null,
     phaseProfile: effectiveProfile,
     currentPhaseIdx: 0,
     currentPhase: effectiveProfile[0],
     completed: false,
     history: [] as Record<string, any>[],
 };
```

## 검증

```
EP-001: end_phase 생략 → rawEnd=NaN → endPhase=maxPhase → 기존 동작
EP-002: start=3 end=3 backend → filter [3] → 1 phase
EP-003: start=5 end=3 → endPhase=max(5,3)=5 → [5]
EP-004: docs start=2 end=2 → filter [] → fallback [3]
EP-005: docs start=2 end=4 → filter [3]
EP-006: checkpoint=true 저장 확인
EP-007: checkpoint 생략 → false
```
