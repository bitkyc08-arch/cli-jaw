# 260226 Session Cleanup 테스트 문서

## 1) 목적
- `end_phase`, `checkpoint`, `continue`, `reset` 동작이 실제 런타임에서 안전하게 이어지는지 검증합니다.
- 특히 **세션 보존/정리 타이밍**과 **의도(intent) 파싱 경계값**을 사람 기준으로 재현 가능한 절차로 확인합니다.

## 2) 범위
- Orchestrator: `src/orchestrator/pipeline.ts`, `src/orchestrator/parser.ts`
- API/입력 라우팅: `server.ts`, `src/telegram/bot.ts`
- Worklog 상태 파서: `src/memory/worklog.ts`

## 3) 사전 준비
1. 서버 실행:
```bash
cd /Users/junny/Documents/BlogProject/cli-jaw
npm run dev
```
2. 별도 터미널에서 관찰용 변수 설정:
```bash
export JAW_HOME="$HOME/.cli-jaw"
export WL_LINK="$JAW_HOME/worklogs/latest.md"
export DB_PATH="$JAW_HOME/jaw.db"
```
3. (선택) 세션 확인 명령:
```bash
sqlite3 "$DB_PATH" "SELECT employee_id, session_id, cli FROM employee_sessions ORDER BY employee_id;"
```

## 4) 자동 테스트 (회귀)

### A-001 타입 검증
```bash
cd /Users/junny/Documents/BlogProject/cli-jaw
npm run -s typecheck
```
기대 결과: 에러 없이 종료.

### A-002 전체 테스트
```bash
cd /Users/junny/Documents/BlogProject/cli-jaw
npm test
```
기대 결과: fail 0.

### A-003 오케스트레이션 관련 테스트 필터
```bash
cd /Users/junny/Documents/BlogProject/cli-jaw
npm test -- --test-name-pattern "EP-|CP-|IN-|RS-|ORT-"
```
기대 결과: 관련 테스트 fail 0.

### A-004 reset regex 경계 확인 (수동 스모크 스크립트)
```bash
node -e "const re=/^페이즈?\s*리셋해?$/i; ['페이즈 리셋해','페이즈리셋해','페이스리셋해'].forEach(s=>console.log(s,re.test(s)));"
```
기대 결과(목표): `"페이즈 리셋해"`는 `true`여야 함.

## 5) 수동 테스트 (사람 검증)

### M-001 기본 완료 경로 (checkpoint 없음)
1. 요청 전송:
```bash
curl -sS -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"간단한 백엔드 점검 태스크를 1회 수행하고 완료 보고해"}'
```
2. 완료 후 확인:
```bash
LATEST="$(readlink "$WL_LINK")"; echo "$LATEST"
grep -n "Status:" "$LATEST"
sqlite3 "$DB_PATH" "SELECT count(*) FROM employee_sessions;"
```
기대 결과:
- Worklog 상태가 `done` 또는 `partial`.
- `done`이면 `employee_sessions`가 비어 있어야 함(세션 정리).

### M-002 checkpoint 진입
1. checkpoint 유도 요청:
```bash
curl -sS -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"JSON subtasks로 backend 1개만 만들고 start_phase=3 end_phase=3 checkpoint=true를 반드시 포함해"}'
```
2. 확인:
```bash
LATEST="$(readlink "$WL_LINK")"
grep -n "Status:" "$LATEST"
grep -n "⏸ checkpoint" "$LATEST"
sqlite3 "$DB_PATH" "SELECT employee_id, session_id FROM employee_sessions ORDER BY employee_id;"
```
기대 결과:
- `Status: checkpoint`
- Matrix에 `⏸ checkpoint` 존재
- employee session이 남아 있음

### M-003 checkpoint 이후 continue
1. continue 실행:
```bash
curl -sS -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"리뷰해봐"}'
```
2. 전/후 세션 비교:
```bash
sqlite3 "$DB_PATH" "SELECT employee_id, session_id FROM employee_sessions ORDER BY employee_id;"
```
기대 결과:
- checkpoint 이후 continue에서도 기존 session_id가 유지되어야 함(핵심).
- Worklog는 다음 라운드로 진행.

### M-004 checkpoint 이후 reset
1. reset 실행:
```bash
curl -sS -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"리셋해"}'
```
2. 확인:
```bash
LATEST="$(readlink "$WL_LINK")"
grep -n "Status:" "$LATEST"
sqlite3 "$DB_PATH" "SELECT count(*) FROM employee_sessions;"
```
기대 결과:
- `Status: reset`
- employee session count = 0

### M-005 continue/reset 가드
1. `done` 또는 `reset` 상태에서 continue:
```bash
curl -sS -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"이어서 해줘"}'
```
기대 결과:
- 이어갈 worklog 없음/이미 완료 메시지.

### M-006 reset intent 경계값
아래 입력을 각각 `/api/message`에 보내고 분기 확인:
- `리셋` => reset으로 처리
- `리셋해` => reset으로 처리
- `리셋해줘` => reset 아님
- `phase reset` => reset으로 처리
- `페이즈 리셋해` => reset으로 처리(목표)
기대 결과:
- 경계값이 의도대로 분기되어야 함.

### M-007 active 실행 중 reset 경쟁 조건
1. 시간이 걸리는 요청 실행.
2. 실행 중 즉시 reset 요청:
```bash
curl -sS -X POST http://localhost:3457/api/message \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"리셋해"}'
```
기대 결과(권장):
- active 작업 중 reset은 거부(409) 또는 큐잉 정책이 명확해야 함.
- 중간 clear로 인한 worklog/session 불일치가 없어야 함.

## 6) 최종 판정 기준
- P0: checkpoint -> continue에서 session_id가 보존된다.
- P0: reset 후 employee_sessions가 항상 0건이다.
- P1: `리셋/리셋해/리셋해줘/phase reset/페이즈 리셋해` 경계 분기가 문서와 일치한다.
- P1: active 중 reset 처리 정책(거부/대기)이 일관된다.
