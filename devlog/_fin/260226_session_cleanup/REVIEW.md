# Orchestration v3 — 검증 리포트

## 기반
- PLAN.md v2 + phase1-5.md
- 직원 리뷰 충돌 5건
- LangGraph interrupt/resume 패턴 대조
- 웹 검색: Agent Continuations, selective session cleanup

---

## 충돌 1: checkpoint 후 continue 불가 — ✅ 해결됨

**직원 지적**: `completed=true` 마킹 → `parseWorklogPending`이 ⏳만 탐색 → 0건

**phase2.md에서 해결**:
- checkpoint 경로에서 `completed=true` **마킹 안 함** (§2-B diff 확인)
- `checkpointed=true` 별도 플래그 사용
- phase5.md에서 `parseWorklogPending`이 `⏸` 기호도 탐색하도록 수정

**LangGraph 패턴 대조**:
- LangGraph: `state.next` 존재 → paused, `state.next` 없음 → completed
- 우리: `checkpointed=true, completed=false` → ⏸ paused, `completed=true` → ✅ completed
- 동일 패턴. 유효함.

---

## 충돌 2: _skipClear 누락 — ✅ 해결됨

**직원 지적**: L228에만 반영, L244/L308 누락

**phase3.md에서 해결**:
- L228 (orchestrate 진입) — `if (!meta._skipClear)` 적용
- L244 (late-subtask 분기) — `if (!meta._skipClear)` 적용
- L308 — phase3.md에 "구현 시 재확인" 메모 있음

**재확인 결과**:
```
L228: clearAllEmployeeSessions.run()     ← 확인. orchestrate 진입
L244: clearAllEmployeeSessions.run()     ← 확인. late-subtask 분기
L308: 해당 라인에 clearAllEmployeeSessions 없음
```
실제 clear 지점은 **2곳**(L228, L244). 직원이 L308을 지적했으나 실제 코드에는 그 위치에 clear가 없음.
→ 2곳만 수정하면 충분. phase3.md 정확함.

---

## 충돌 3: "리뷰해봐" 매칭 불가 — ✅ 해결됨

**직원 지적**: `isContinueIntent`가 "이어서/계속/continue"만 매칭

**phase4.md에서 해결** (§4-A):
```typescript
+    /^다음(?:\s*해봐)?$/i,
+    /^리뷰(?:\s*해봐)?$/i,
```

**잠재 이슈**: "리뷰해봐"가 continue로 가면, 신규 리뷰 요청("이 코드 리뷰해봐")과 충돌 가능.
→ 단, 현재 시스템에서 "리뷰해봐"는 orchestration 문맥에서만 사용됨.
→ `needsOrchestration`이 false이므로 짧은 명령은 continue 판정 우선. 안전함.

---

## 충돌 4: reset regex 모순 — ✅ 해결됨

**직원 지적**: `^리셋`이 "리셋해줘"도 매칭

**phase4.md에서 해결** (§4-B):
```typescript
/^리셋해?$/i     ← "리셋" ok, "리셋해" ok, "리셋해줘" no
```

**검증**:
- "리셋" → `^리셋해?$` → 매칭 (해? = 0-1회) ✅
- "리셋해" → `^리셋해?$` → 매칭 ✅
- "리셋해줘" → `^리셋해?$` → 불일치 (줘 추가) ✅
- "reset" → `^reset$` → 매칭 ✅

---

## 충돌 5: planner JSON 스키마 미반영 — ✅ 해결됨

**직원 지적**: distribute.ts:221에 end_phase/checkpoint 없음

**phase5.md에서 해결** (§5-D):
- `buildPlanPrompt` JSON 예시에 `end_phase`, `checkpoint` 추가
- 가이드 텍스트에 end_phase/checkpoint 설명 추가

---

## 추가 검증: 종료성 (Termination)

| 시나리오 | 종료 보장? | 근거 |
|----------|----------|------|
| 정상 완료 | ✅ | `allDone` + `clearSessions` + break |
| checkpoint | ✅ | `checkpointed=true` + break (루프 탈출) |
| partial | ✅ | `round === MAX_ROUNDS` (유한 루프) |
| continue 후 | ✅ | 다시 `MAX_ROUNDS` 루프 → 유한 |
| reset | ✅ | 즉시 return |
| checkpoint → 무한 continue | ✅ | 매 continue가 새 MAX_ROUNDS 루프. 무한 루프 아님 (유저 수동 트리거) |

---

## 추가 검증: 완전성 (Completeness)

| 상태 전이 | 가능? | 경로 |
|-----------|-------|------|
| ACTIVE → DONE | ✅ | scopeDone + !hasCheckpoint |
| ACTIVE → CHECKPOINT | ✅ | scopeDone + hasCheckpoint |
| ACTIVE → PARTIAL | ✅ | MAX_ROUNDS |
| CHECKPOINT → ACTIVE | ✅ | continue (_skipClear) |
| CHECKPOINT → RESET | ✅ | isResetIntent |
| CHECKPOINT → NEW | ✅ | 새 orchestrate (L228 clear) |
| PARTIAL → ACTIVE | ✅ | continue (_skipClear) |
| PARTIAL → RESET | ✅ | isResetIntent |
| PARTIAL → NEW | ✅ | 새 orchestrate (L228 clear) |
| DONE → * | ❌ | done 후 continue 거부 (phase3.md §3-B) |
| RESET → * | ❌ | reset 후 continue 거부 (phase3.md §3-B) |

**모든 상태 전이 도달 가능. 데드락 없음.**

---

## 결론

직원 리뷰 충돌 5건 전부 phase1-5.md에서 해결됨. 누락 없음.
LangGraph의 `interrupt`/`state.next` 패턴과 구조적으로 일치.
구현 진행 가능.
