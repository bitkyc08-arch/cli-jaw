# Phase 5: Stabilization & Polish

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

## A. 미완료 사항 (실행 대상)

| #   | 항목                                               | 출처             | 파일                                   | 난이도 |
| --- | -------------------------------------------------- | ---------------- | -------------------------------------- | ------ |
| A1  | `addSystemMsg`에서 응답 `type` 기반 색상 분기      | Phase 3 향후개선 | `public/js/ui.js` + `chat.js`          | 🟢      |
| A2  | `slash-commands.js` `loadCommands` catch 에러 로깅 | Phase 3 향후개선 | `public/js/features/slash-commands.js` | 🟢      |
| A4  | Async argument provider 로딩 스피너 (Phase 4 A3)   | Phase 4 계획     | `bin/commands/chat.js`                 | 🟡      |
| A5  | 모바일 `visualViewport` 드롭다운 가림 (Phase 3 W4) | Phase 3 향후개선 | `public/css/chat.css`                  | 🟡      |

---

## B. 에러 핸들링 / 방어 코드

| #   | 항목                                 | 파일                         | 설명                                                                                           | 난이도 |
| --- | ------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| B1  | `config.js` `detectCli` 하드닝       | `src/config.js:153`          | `execSync(\`which ${name}\`)` 대신 `execFile/spawn` 계열 검토 (현 상태는 저위험이나 방어 강화) | 🟢      |
| B2  | `commands.js` `safeCall` 관측성 부족 | `src/commands.js:148`        | 현재 bare `catch {}`로 에러 삼킴 → debug 모드 로깅 또는 원인 태깅 추가                         | 🟢      |
| B3  | Web `/api/command` 타임아웃          | `public/js/features/chat.js` | 서버 무응답 시 fetch 대기 → `AbortSignal.timeout()` + `AbortController` fallback 추가          | 🟡      |
| B4  | argument provider 에러 전파          | `src/commands.js`            | `getArgumentCompletions` 예외 시 popup 깨짐 가능 → try-catch + 빈 배열 fallback                | 🟢      |
| B5  | resize 이벤트 debounce               | `bin/commands/chat.js`       | Phase 4 계획에 있었으나 구현 여부 확인 필요                                                    | 🟡      |

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

| #   | 항목                                 | 파일                                  | 설명                                                                                |
| --- | ------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| D1  | `slash_commands.md` 코드 스니펫 블록 | `devlog/260224_cmd/slash_commands.md` | Phase 1–4 구현 완료로 계획 코드 스니펫이 낡음 → 실코드 기준 정리 또는 "구현됨" 표시 |
| D3  | Phase 문서 상태 일괄 갱신            | `devlog/260224_cmd/phase*.md`         | 모두 ✅ 반영, str_func 동기화                                                        |

---

## D-1. 이미 완료된 항목 (재작업 제외)

| #   | 항목                                          | 상태 | 근거                                   |
| --- | --------------------------------------------- | ---- | -------------------------------------- |
| A3  | Web dropdown 빈결과 메시지                    | ✅    | `public/js/features/slash-commands.js` |
| D2  | chat.js `/mcp` 레거시 하드코딩 분기 제거 확인 | ✅    | `bin/commands/chat.js`                 |

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
