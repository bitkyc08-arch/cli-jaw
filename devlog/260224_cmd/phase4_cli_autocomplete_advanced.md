# Phase 4: Autocomplete Advanced Layer

> 상태: 📋 신규 계획
> 날짜: 2026-02-24
> 선행조건: Phase 1.3c 완료 (필수), Phase 2~3 완료 (권장)

Phase 4는 "보여주기"가 아니라 **실사용성**을 올리는 단계입니다.
Phase 1이 command name 선택까지라면, Phase 4는 Codex 스타일에 더 가깝게 **인자 자동완성 + 정렬 품질 + 긴 목록 네비게이션**을 추가합니다.

---

## 목표

1. 커맨드 인자 자동완성 지원 (`/model`, `/cli`, `/skill`, `/browser` 등)
2. prefix-only에서 점수 기반 정렬로 개선 (정확도 + 사용성)
3. 목록이 길어도 스크롤 가능한 popup (page window)
4. raw TTY/resize 상황에서 안정 동작 유지

---

## Context7 기반 기술 방향

### 1) 키 입력 확장 처리는 raw stdin 시퀀스 정규화 기반 유지

현재 `chat.js`는 raw stdin + ESC 시퀀스(`\x1b[A`, `\x1bOA` 등) 파싱 구조를 사용 중이므로,
Phase 4도 동일한 입력 경로를 유지한다.
(`emitKeypressEvents` 전환은 별도 리팩터로 분리)

### 2) 고빈도 재렌더링에서도 cursor 제어 API 사용

Page 스크롤/하이라이트 업데이트가 늘어나므로
`cursorTo/moveCursor/clearLine` 또는 동등한 ANSI cursor 제어 루프를 유지해야
깜박임과 잔상을 줄일 수 있습니다.

> 출처: [Node.js readline API (cursorTo, moveCursor, clearLine)](https://github.com/nodejs/node/blob/main/doc/api/readline.md)

### 3) resize 이벤트를 기능 스펙으로 승격

Phase 4에서 popup page window를 넣으면 `rows/columns` 변화 반영이 필수이므로 resize 시 재계산 로직을 정식 플로우로 문서화합니다.

> 출처: [Node.js tty API (resize event)](https://github.com/nodejs/node/blob/main/doc/api/tty.md)

### 4) raw mode 전제 명시

raw stdin 시퀀스 파싱은 TTY raw mode가 전제다.

```js
if (process.stdin.isTTY) process.stdin.setRawMode(true);
```

> 출처: [Node.js tty API (readStream.setRawMode)](https://github.com/nodejs/node/blob/main/doc/api/tty.md)

---

## 기능 설계

## A. 인자 자동완성 provider

`src/commands.js` 메타데이터 확장:

```js
{
  name: 'model',
  args: '[name]',
  getArgumentCompletions: async (ctx, argv, partial) => [
    { value: 'gpt-5.3-codex', label: 'Codex default' },
    { value: 'gemini-2.5-pro', label: 'Gemini Pro' }
  ]
}
```

동작 규칙:
- `/model g` 상태에서 `g*` 모델 후보를 popup으로 표시
- `/cli c` 상태에서 `claude/codex` 후보 제시
- command stage와 argument stage를 분리

> 🔧 **UX 반영 (A1)**: argument stage 전환 시 popup 상단에 context 표시:
>
> ```
> model ▸ 모델 선택
> ────────────────────────
>   gpt-5.3-codex     Codex default
>   gemini-2.5-pro    Gemini Pro
> ```
>
> 구현: `formatAutocompleteLine` 첫 줄에 dim 텍스트로 context 헤더 렌더

> 🔧 **UX 반영 (A3)**: async provider 로딩 중 상태 표시:
>
> ```js
> // provider가 async이면 로딩 spinner 표시
> const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
> // popup 영역에 "⠋ 로딩 중..." 한 줄 표시 후 결과 도착 시 교체
> ```

## B. 후보 점수화

현재 prefix match만 사용 중이라 후보가 많으면 품질이 낮습니다.
Phase 4에서는 간단한 점수함수 도입:

- 점수 우선순위
  - exact match: +100
  - startsWith: +60
  - includes: +30
  - 최근 사용 히스토리 보정: +N

출력은 점수 내림차순 + 이름 오름차순.

## C. popup 페이징

데이터가 20개 이상일 때도 사용 가능하도록 window 도입:

```js
ac = {
  open: true,
  items: [...],
  selected: 13,
  windowStart: 8,
  windowSize: 8,
}
```

키 바인딩:
- `up/down`: 한 칸
- `pageup/pagedown`: windowSize 단위
- `home/end`: 첫/끝 이동

> 🔧 **UX 반영 (A2)**: PageUp/PageDown ESC 시퀀스 명시:
>
> | 키 | raw ESC 시퀀스 |
> |---|---|
> | `PageUp` | `\x1b[5~` |
> | `PageDown` | `\x1b[6~` |
> | `Home` | `\x1b[H` 또는 `\x1b[1~` |
> | `End` | `\x1b[F` 또는 `\x1b[4~` |
>
> ⚠️ iTerm2와 macOS Terminal에서 시퀀스가 다를 수 있으므로 둘 다 지원 필요.

## D. 입력 확정 정책 정교화

- `Tab`: 항상 "치환만" (실행 금지)
- `Enter`:
  - popup open + command stage + 인자 없음 -> 즉시 실행
  - popup open + 인자 필요/argument stage -> 치환 후 입력 대기

> 🔧 **UX 반영 (A4)**: `Right Arrow` 치환 제거 권장
> 일반 입력 중 Right는 커서 이동인데 popup에서만 치환이면 혼동 유발.
> Tab으로 통일 권장.

## E. 성능/안정성 가드

- 입력 1회당 최대 1회 렌더 (coalesce)
- resize 연속 이벤트 debounce
- popup 문자열 길이 clamp (긴 desc 잘라내기)

---

## 구현 단계

### Step 1. `src/commands.js` 메타데이터 확장

- optional `getArgumentCompletions(ctx, argv, partial)` 추가
- 기본 커맨드 4종 우선 적용:
  - `/model`
  - `/cli`
  - `/skill`
  - `/browser`

### Step 2. `chat.js` completion engine 분리

- `resolveCompletions(inputBuf, ctx)` 함수화
  - stage 판별(command vs argument)
  - provider 호출
  - 점수 정렬

### Step 3. popup window/paging 구현

- `selected` 변경 시 `windowStart` 동기화
- page 키 바인딩 추가

### Step 4. acceptance policy 반영

- Tab/Enter/Right 처리 분기 정교화
- 기존 command 실행 루프와 충돌 방지

### Step 5. telemetry + 회귀 체크

- debug 모드에서 `ac.renderCount`, `ac.maxItems`, `ac.lastLatencyMs` 출력
- raw 모드/기존 slash 실행이 깨지지 않는지 회귀 확인

---

## 변경 파일

- `src/commands.js` (provider 메타데이터 추가)
- `bin/commands/chat.js` (completion engine + paging + key bindings)
- 선택: `devlog/260224_cmd/phase4_autocomplete_test.md` (테스트 로그)

---

## 난이도 / 공수

| 항목                                     | 난이도 | 공수    |
| ---------------------------------------- | ------ | ------- |
| argument provider 스키마 추가            | 🟡      | 40m     |
| completion resolver(stage 분기 + 점수화) | 🟠      | 60m     |
| paging UI + key bindings                 | 🟠      | 55m     |
| Enter/Tab 정책 정교화                    | 🟡      | 35m     |
| 회귀 테스트                              | 🟡      | 35m     |
| 합계                                     |        | 약 3.8h |

---

## 리스크 / 대응

| 리스크                           | 확률 | 영향 | 대응                                                           |
| -------------------------------- | ---- | ---- | -------------------------------------------------------------- |
| provider 호출 지연으로 입력 렉   | 보통 | 보통 | sync provider 우선, async는 timeout fallback                   |
| page/window 계산 버그            | 보통 | 보통 | selected/windowStart 불변식 테스트                             |
| Enter 정책 혼동                  | 높음 | 보통 | command stage/argument stage 명시적 분기                       |
| resize 후 index 유실             | 보통 | 낮음 | resize 시 selected clamp + rerender                            |
| `Ctrl+N/P` 터미널 충돌           | 보통 | 보통 | A5: macOS Terminal에서 Ctrl+N=새창. iTerm2 외엔 미지원 문서화  |
| Phase 1c `ensureSpaceBelow` 호환 | 보통 | 보통 | A6: `visibleRows` 변경 시 항상 `ensureSpaceBelow(n)` 선행 호출 |

---

## 완료 기준 (DoD)

1. command + argument stage 자동완성 모두 동작
2. 20개 이상 후보에서 paging 동작
3. Tab/Enter 동작이 문서 정책과 일치
4. `/reset confirm`, `/mcp install`, `/memory query` 등 기존 command 실행 회귀 없음
5. resize/한글 입력/ESC 처리에서 잔상 또는 비정상 상태 없음

---

## 수동 검증 시나리오

1. `/model g` -> `g*` 모델 후보
2. `/cli o` -> `opencode` 후보
3. 긴 목록에서 `PageDown`/`PageUp`
4. `Tab`은 치환만, `Enter`는 정책대로 실행/대기 분기
5. resize 중 popup 유지/복구
6. autocomplete 닫힌 뒤 일반 입력/전송 정상
