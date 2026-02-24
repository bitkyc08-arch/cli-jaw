# Phase 5: 안정화 + 커맨드 정비

> **의존**: Phase 3-4 완료
> **검증일**: 2026-02-24
> **산출물**: isContinueIntent 엄격화, seedDefaultEmployees 헬퍼, /employee CLI, /reset 통합, /skill reset 웹 해금

---

## 5-A: Continue Intent 안정화

### 문제

- `/이어서|계속|continue/i` 광범위 regex → 일반 문장 오탐
- `activeProcess` 체크 뒤에 있어서 실행 중 입력은 큐 경로로 빠짐

### 해결

`orchestrator.js`에 `isContinueIntent()` 공용 함수 추출:

```javascript
const CONTINUE_PATTERNS = [
    /^\/?continue$/i,
    /^이어서(?:\s*해줘)?$/i,
    /^계속(?:\s*해줘)?$/i,
];
export function isContinueIntent(text) { ... }
```

**모든 진입점**에서 큐 진입 전 체크:
- `server.js`: WS 핸들러 + `/api/message` (실행 중이면 안내 메시지)
- `src/agent.js`: `processQueue`에서 dequeue된 메시지도 분기
- `src/telegram.js`: 텔레그램 메시지 경로도 분기

---

## 5-B: seedDefaultEmployees 헬퍼

`server.js`에서 기본 직원 생성 로직을 `seedDefaultEmployees({ reset, notify })` 함수로 추출:

- `DEFAULT_EMPLOYEES` 모듈 레벨 상수 (중복 제거)
- `reset=false` (기본): 비어있을 때만 seed
- `reset=true`: 전체 삭제 후 재생성
- `notify=true`: WebSocket `agent_updated` broadcast

호출 경로: startup seed, `POST /api/employees/reset`, `/employee reset` 슬래시, `makeWebCommandCtx`

---

## 5-C: `/employee reset` 명령

| 경로                    | 구현                                         | L   |
| ----------------------- | -------------------------------------------- | --- |
| 슬래시 커맨드           | `commands.js` → `employeeHandler` (cli, web) |     |
| CLI 명령                | `bin/commands/employee.js`                   | 67L |
| `bin/commands/reset.js` | [NEW] CLI 전체 초기화 (y/N, 서버 체크)       | 97L |
| `bin/cli-claw.js`       | [MODIFY] employee + reset 서브커맨드 등록    | 93L |
| Web chat.js             | `resetEmployees` ctx 연결                    |     |

---

## 5-D: `/reset` 전체 초기화 통합

기존:
- `/clear` — 화면 정리 (비파괴)
- `/reset confirm` — 세션/대화만 초기화
- `/skill reset`, `/employee reset` — 개별 초기화

통합 후:
- `/clear` — 화면 정리 (비파괴, 유지)
- `/reset confirm` — **전체 초기화**: 스킬 + 직원 + MCP sync + 세션 (cli, web)
- `/skill reset`, `/employee reset` — 개별 초기화 (유지)

---

## 5-E: `/skill reset` 웹 UI 해금

- `skillHandler`의 `ctx.interface !== 'cli'` 차단 제거
- `makeWebCommandCtx`에 `resetSkills` 추가
- 이제 웹 UI에서도 `/skill reset` 가능

---

## 5-F: CLI reset 안정성

### `bin/commands/reset.js` 개선

- **서버 연결 확인**: 리셋 시도 전 `/api/session` ping → 실패 시 "서버에 연결할 수 없습니다" 메시지
- **`confirm` 인자**: `cli-claw reset confirm` = `cli-claw reset --yes` 동일 동작
- **chat.js `resetSkills`**: `spawnSync(skill.js reset --force)` → `POST /api/skills/reset` API 호출로 교체
- **`/api/skills/reset`**: server.js에 endpoint 추가 (`copyDefaultSkills` + `ensureSkillsSymlinks` + `regenerateB`)

---

## 파일 변경 요약

| 파일                         | 작업                                                                      | L    |
| ---------------------------- | ------------------------------------------------------------------------- | ---- |
| `src/orchestrator.js`        | [MODIFY] `isContinueIntent` 공용 함수, needsOrchestration, 순차 실행      | 583L |
| `server.js`                  | [MODIFY] `seedDefaultEmployees`, `resetSkills` ctx, continue-before-queue | 832L |
| `src/agent.js`               | [MODIFY] `processQueue` continue 분기                                     | 427L |
| `src/telegram.js`            | [MODIFY] `isContinueIntent` 분기                                          | 382L |
| `src/commands.js`            | [MODIFY] `/reset` 통합, `/employee`, `/skill reset` 해금                  | 647L |
| `bin/commands/employee.js`   | [NEW] CLI employee reset 명령                                             | 67L  |
| `bin/cli-claw.js`            | [MODIFY] employee 서브커맨드 등록                                         | 89L  |
| `bin/commands/chat.js`       | [MODIFY] `resetEmployees` ctx + continued                                 | 844L |
| `public/js/features/chat.js` | [MODIFY] 에러 핸들링 + continued 표시                                     | 160L |
