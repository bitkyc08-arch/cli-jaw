# Phase 9.6: catch 정책 + 예외 처리 일관화 실행

> Phase 8.4 설계 기반. 빈 `catch {}` 블록에 로깅/주석을 추가하여 운영 관측성 확보.

---

## 변경 요약

### 상 등급 (즉시 수정) — 완료

| # | 파일 | 패턴 | 조치 | 상태 |
|---|---|---|---|---|
| 1 | `server.js` L223 | WS message parse | `console.warn` + raw preview | ✅ |
| 2 | `server.js` L168 | gemini creds parse | `/* expected */` 주석 | ✅ |
| 3 | `src/agent.js` L28 | kill SIGTERM | `console.warn` + pid | ✅ |
| 4 | `src/agent.js` L31 | kill SIGKILL | `console.warn` + pid | ✅ |
| 5 | `src/orchestrator.js` L100 | subtask JSON #1 | `console.debug` + preview | ✅ |
| 6 | `src/orchestrator.js` L104 | subtask JSON #2 | `console.debug` + preview | ✅ |
| 7 | `src/orchestrator.js` L119,129 | direct_answer JSON | `/* expected */` 주석 | ✅ |
| 8 | `src/orchestrator.js` L148,152 | verdict JSON | `/* expected */` 주석 | ✅ |
| 9 | `src/orchestrator.js` L383 | phases_completed | `console.debug` | ✅ |
| 10 | `src/telegram.js` L207 | bot stop | `console.warn` + error | ✅ |

### Tier 분류 원칙

| Tier | 대상 | 조치 |
|---|---|---|
| 상 (즉시) | 프로세스 kill, 봇 정지, WS parse | `console.warn` + 컨텍스트 |
| 중 (선별) | JSON 파싱, 외부 서비스 | `console.debug` + preview |
| 낮 (보류) | 초기화 fallback, 파일 부재 | `/* expected: ... */` 주석 |

---

## 충돌 분석

| 대상 | 충돌 |
|---|---|
| Phase 9.1 (보안 가드) | 없음 |
| Phase 9.3 (라우트 분리) | 병행 가능 — catch 수정과 라우트 이동은 독립 |
| Phase 9.4 (테스트) | 없음 — 행동 변경 없는 리팩터링 |

---

## 검증

```bash
npm test  # 206 pass, 0 fail

# 주석/로깅 없는 빈 catch 잔량 확인
rg -n "catch \{" server.js src lib -g'*.js' | \
  rg -v "console\.(warn|error|debug|log|info)" | \
  rg -v "/\*" | \
  rg -v "expected|ok|fine|ignore|skip|first run"
```

---

## 완료 기준

- [x] 상 등급 10건 모두 warn/debug/주석 추가
- [x] 기존 `npm test` 통과 (206/206)
- [ ] 중 등급 5건+ 추가 처리 (향후)
- [ ] 잔여 빈 catch 5건 이하 확인
