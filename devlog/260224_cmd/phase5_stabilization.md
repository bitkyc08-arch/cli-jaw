# (fin) Phase 5: Stabilization & Polish

> 상태: ✅ 구현 완료 | 날짜: 2026-02-24
> 범위: Phase 1–4 전체 회귀 방지 + 미완료 UX 사항 + 에러 핸들링
> 선행조건: Phase 4 ✅ 완료

Phase 4까지 **기능 구현**은 끝났다.
Phase 5는 빠르게 쌓은 코드에서 빠진 에러 핸들링, 미반영 UX, 회귀 리스크를 잡는 **안정화 단계**다.

---

## 목표

1. 이전 Phase 리뷰에서 나온 미완료 사항 전부 처리
2. 에러 핸들링 / 경계 조건 보강
3. Cross-interface 회귀 확인 (CLI, Web, Telegram)
4. 불필요한 코드 / 레거시 정리

---

## A. 미완료 사항

| #   | 항목                           | 상태 | 비고                                                  |
| --- | ------------------------------ | ---- | ----------------------------------------------------- |
| A1  | `addSystemMsg` type 색상 분기  | ✅    | `ui.js` + `chat.css` + `chat.js` (Web)                |
| A2  | `loadCommands` catch 에러 로깅 | ✅    | `slash-commands.js` console.warn 추가                 |
| A4  | Async argument provider 스피너 | ⏭️    | 현재 provider 전부 동기 — async provider 추가 시 구현 |
| A5  | 모바일 `visualViewport` 대응   | ⏭️    | 데스크톱 위주 — 모바일 대응 시 구현                   |

---

## B. 에러 핸들링 / 방어 코드

| #   | 항목                   | 상태 | 적용 내용                                               |
| --- | ---------------------- | ---- | ------------------------------------------------------- |
| B1  | `detectCli` 하드닝     | ✅    | `execFileSync` + 입력 검증 (`/^[a-z0-9_-]+$/i`)         |
| B2  | `safeCall` 관측성      | ✅    | `DEBUG` 환경변수 시 `console.warn` 로깅                 |
| B3  | Web fetch 타임아웃     | ✅    | `AbortSignal.timeout(10s)` + `AbortController` fallback |
| B4  | argument provider 방어 | ✅    | try-catch + 빈 배열 fallback                            |
| B5  | resize debounce        | ✅    | `setTimeout(handleResize, 50)` debounce                 |

---

## B-1. 근거 링크 (보정 근거)

- `exec/execSync`는 shell을 통해 실행되므로 입력 안전성 주의가 필요하다.
> 출처: [Node.js child_process API](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)

- `execFile`은 기본적으로 shell을 띄우지 않아 `exec` 대비 안전하고 효율적이다.
> 출처: [Node.js child_process API](https://github.com/nodejs/node/blob/main/doc/api/child_process.md)

- `AbortSignal.timeout()`은 Web API 기준 최근 브라우저 baseline 기능이다.
> 출처: [AbortSignal.timeout() - MDN](https://developer.mozilla.org/docs/Web/API/AbortSignal/timeout_static)

- 모바일 viewport 대응은 `window.visualViewport` 가드가 필요하다.
> 출처: [VisualViewport - MDN](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)

---

## C. Cross-Interface 회귀 체크

| #   | 테스트                          | 인터페이스   | 확인 사항                                    |
| --- | ------------------------------- | ------------ | -------------------------------------------- |
| C1  | `/help`                         | CLI, Web, TG | 인터페이스별 필터링, 카테고리 그룹           |
| C2  | `/model` + `/cli`               | CLI, Web, TG | 인자 있을 때 설정 변경, 없을 때 현재 값 표시 |
| C3  | `/model ` argument autocomplete | CLI          | 모델별 CLI label 정상 표시                   |
| C4  | `/clear` vs `/reset confirm`    | CLI, Web     | 비파괴/파괴 분리 확인                        |
| C5  | 알 수 없는 커맨드 (`/foobar`)   | CLI, Web, TG | 에러 메시지 + type: 'error'                  |
| C6  | 일반 텍스트 전송                | CLI, Web, TG | 슬래시 아닌 메시지가 agent로 정상 전달       |
| C7  | Web dropdown 한글 입력          | Web          | IME 호환, compositionend 처리                |
| C8  | CLI PageUp/PageDown/Home/End    | CLI          | 긴 모델 목록 paging                          |

---

## D. 레거시 정리

| #   | 항목                       | 상태 | 비고                                          |
| --- | -------------------------- | ---- | --------------------------------------------- |
| A3  | Web dropdown 빈결과 메시지 | ✅    | 기존 구현 확인 (재작업 불필요)                |
| D1  | `slash_commands.md` 상태   | ✅    | `📋 계획` → `✅ 구현 완료 (Phase 1–5)` 반영     |
| D2  | `/mcp` 레거시 분기 제거    | ✅    | 기존 구현 확인 (재작업 불필요)                |
| D3  | Phase 문서 상태 일괄 갱신  | ✅    | Phase 1–5 전부 `✅ 구현 완료`, str_func 동기화 |

---

## 구현 순서

```
Step 1: B 항목 (에러 핸들링) — 방어 코드 먼저
Step 2: A1–A2 (미완료 UX) — 빠르게 끝나는 것부터
Step 3: C 항목 (회귀 체크) — curl + 브라우저 테스트
Step 4: D 항목 (레거시 정리) — 문서/코드 정리
Step 5: A4–A5 (선택 UX) — 시간 여유 시
```

---

## 난이도 / 공수

| 항목                | 난이도 | 공수                   |
| ------------------- | ------ | ---------------------- |
| A1–A2 미완료 UX     | 🟢      | 20m                    |
| B1–B5 에러 핸들링   | 🟢–🟡    | 45m                    |
| C1–C8 회귀 체크     | 🟡      | 60m                    |
| D1 + D3 레거시 정리 | 🟢      | 25m                    |
| A4–A5 선택 UX       | 🟡      | 45m (optional)         |
| **합계**            |        | **~2.5h** (필수 ~1.8h) |

---

## 검증

### curl 스크립트

```bash
# C1: /help 인터페이스 필터
curl -s -X POST localhost:3457/api/command \
  -H 'Content-Type: application/json' \
  -d '{"text":"/help"}' | jq .

# C2: /model 현재 확인 + 변경
curl -s -X POST localhost:3457/api/command \
  -d '{"text":"/model"}' -H 'Content-Type: application/json' | jq .
curl -s -X POST localhost:3457/api/command \
  -d '{"text":"/model gemini-2.5-pro"}' -H 'Content-Type: application/json' | jq .

# C4: /clear 비파괴 확인
curl -s localhost:3457/api/messages | jq 'length'
curl -s -X POST localhost:3457/api/command \
  -d '{"text":"/clear"}' -H 'Content-Type: application/json' | jq .
curl -s localhost:3457/api/messages | jq 'length'  # 같아야 함

# C5: unknown command
curl -s -X POST localhost:3457/api/command \
  -d '{"text":"/foobar"}' -H 'Content-Type: application/json' | jq .

# A1: type 필드 확인
curl -s -X POST localhost:3457/api/command \
  -d '{"text":"/status"}' -H 'Content-Type: application/json' | jq '.type'
# → "info"

curl -s -X POST localhost:3457/api/command \
  -d '{"text":"/unknown123"}' -H 'Content-Type: application/json' | jq '.type'
# → "error"
```

### 수동 검증 (CLI)

1. `cli-claw chat`에서 `/model g` → 모델 목록 + CLI 라벨 확인
2. PageDown → paging 확인
3. Tab → 선택 확인, Enter → 실행 확인
4. 일반 텍스트 입력 → agent 정상 실행

### 수동 검증 (Web)

1. `http://localhost:3457` 접속
2. 입력창에 `/` → 드롭다운 표시
3. `/model` 입력 → command stage dropdown 동작 확인 (현재 Web은 argument stage 미적용)
4. `/status` → 시스템 메시지 (A1 반영 후 type 색상 확인)

---

## 완료 기준 (DoD)

1. B1–B5 에러 핸들링 모두 적용
2. A1–A2 미완료 UX 반영
3. C1–C8 회귀 체크 전부 통과
4. D1 + D3 레거시 정리 완료
5. str_func + README 동기화 커밋
