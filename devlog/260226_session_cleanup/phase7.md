# Phase 7: 최종 마무리 (Polish)

## 개요
Phase 6 안정화 후 직원 리뷰에서 발견된 잔여 4건 처리.
코드 변경 2건 + 문서 수정 2건.

---

## 7-A: `tg.resetDone` i18n 키 추가 (P1)

**문제**: `bot.ts:460` `t('tg.resetDone')` → 로케일 파일에 키 없음 → `"tg.resetDone"` 문자열 그대로 노출.
`|| '리셋 완료.'` fallback은 `t()`가 truthy(키 이름 반환)라 도달 불가.

**수정**:
- `public/locales/ko.json`: `"tg.resetDone": "리셋 완료."` 추가
- `public/locales/en.json`: `"tg.resetDone": "Reset complete."` 추가
- `bot.ts:460`: `|| '리셋 완료.'` fallback 제거 (불필요)

---

## 7-B: `spawn.ts` queue/steer에 `isResetIntent` 분기 (P2)

**문제**: `steerAgent` L86과 `processQueue` L111에서 `isContinueIntent`만 체크.
큐에 reset이 들어오면 `orchestrate()`로 실행됨.

**현재 상태**: 모든 진입점(WS/HTTP/Telegram)에서 reset은 `activeProcess` 가드로 차단되므로 큐에 reset이 도달할 확률은 매우 낮음.

**수정**: 방어적으로 `isResetIntent` 분기 추가.

```diff
 // steerAgent (L86)
-    if (isContinueIntent(newPrompt)) orchestrateContinue({ origin });
+    if (isResetIntent(newPrompt)) orchestrateReset({ origin });
+    else if (isContinueIntent(newPrompt)) orchestrateContinue({ origin });
     else orchestrate(newPrompt, { origin });

 // processQueue (L111)
-    if (isContinueIntent(combined)) orchestrateContinue({ origin });
+    if (isResetIntent(combined)) orchestrateReset({ origin });
+    else if (isContinueIntent(combined)) orchestrateContinue({ origin });
     else orchestrate(combined, { origin });
```

---

## 7-C: `phase6.md` 문서 정정 (P3)

**문제**: phase6.md Fix C 테이블에 "Telegram 수정 불필요"라 되어 있지만, 실제로는 `bot.ts:450`에 reset guard 추가됨.

**수정**: "수정 불필요" → "bot.ts:450 reset guard 추가됨" 으로 정정.

---

## 7-D: `test.md` 정규식 업데이트 (P3)

**문제**: `test.md` A-004에서 `스*` 패턴이 남아 있음 (코드는 이미 `\s*`로 수정됨).

**수정**: `스*` → `\s*`로 업데이트.

---

## 추가 테스트

| ID | 테스트 | 유형 |
|----|--------|------|
| LK-001 | `tg.resetDone` 키가 ko.json/en.json에 존재 | unit (기존 locale key 테스트에 자동 포함) |

---

## 검증
1. `npm test` — 299 pass 유지
2. `npx tsc --noEmit` — 타입 체크
3. i18n 키 테스트 자동 통과 확인 (locale JSON key 일치 테스트)
