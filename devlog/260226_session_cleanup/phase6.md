# Phase 6: 안정화 (Stabilization)

## 개요
Phase 1-5 구현 완료 후 직원 리뷰에서 발견된 3건의 실제 버그 수정 + 테스트 보강.

---

## Fix A: L353 `clearAllEmployeeSessions` — `_skipClear` 누락 (P0)

**문제**: `orchestrate()` 진입 시 L244에서 `_skipClear` 체크하지만, L353에서 worklog 생성 직후 **무조건** 다시 클리어.
`orchestrateContinue` → `_skipClear: true` → L244 통과 → L353에서 세션 날아감.

**수정**: L353에 동일한 `_skipClear` 가드 적용.

```diff
-    clearAllEmployeeSessions.run();
+    if (!meta._skipClear) clearAllEmployeeSessions.run();
```

**영향 범위**: `pipeline.ts` L353 (1줄)

---

## Fix B: 정규식 오타 — `스*` → `\s*` (P1)

**문제**: `parser.ts` L24의 `/^페이즈?스*리셋해?$/i`에서 `스*`는 "스" 문자의 반복.
"페이즈 리셋해"(공백 포함)를 매칭하지 못함.

**수정**:
```diff
-    /^페이즈?스*리셋해?$/i,
+    /^페이즈?\s*리셋해?$/i,
```

**영향 범위**: `parser.ts` L24 (1줄)

---

## Fix C: reset `activeProcess` 가드 (P1)

**문제**: `orchestrateReset`이 `activeProcess` 체크 없이 즉시 실행됨.
실행 중 에이전트의 세션이 중간에 삭제될 수 있음.

**수정**: `server.ts` WS/HTTP 경로 + `bot.ts` Telegram 경로에 `activeProcess` 가드 추가.

| 경로 | 행 | 수정 |
|------|-----|------|
| WS (cli) | server.ts L195-201 | `if (activeProcess)` → busy 응답 |
| HTTP `/api/message` | server.ts L408-411 | `if (activeProcess)` → 409 |
| HTTP `/api/orchestrate/reset` | server.ts L431-433 | `if (activeProcess)` → 409 |
| Telegram | bot.ts L450 | `if (activeProcess)` → busy 응답, idle → `orchestrateReset` 직접 실행 |

---

## 추가 테스트

| ID | 테스트 | 유형 |
|----|--------|------|
| RS-006 | "페이즈 리셋" → reset (regex fix 검증) | unit |
| RS-007 | "페이즈리셋" → reset | unit |

---

## 검증 계획
1. `npm test` — 299 pass 통과
2. `npx tsc --noEmit` — 타입 체크
3. 수동: "리셋해" 입력 시 agent busy이면 거부 확인
