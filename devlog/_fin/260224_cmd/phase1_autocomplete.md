# (fin) Phase 1: Interactive Slash Autocomplete (Revised)

> 상태: ✅ 구현 완료 (v3)
> 날짜: 2026-02-24
> 범위: `bin/commands/chat.js` default/raw 모드

`chat.js`에 slash autocomplete popup의 최소 안정 버전을 구현했습니다. 입력 중 `/` prefix를 기준으로 후보를 유지 렌더링하고, 화살표 이동/선택/닫기까지 raw stdin 루프에서 동작합니다.

핵심은 UI 화려함보다, 기존 raw stdin 루프/scroll region/footer와 충돌 없이 유지되는 것입니다.

---

## Context7 확인 사항

### 1) 키 입력 처리: raw 문자열 파싱보다 `keypress` 이벤트 사용

Node는 TTY 입력에서 `readline.emitKeypressEvents(process.stdin)` + `process.stdin.setRawMode(true)` 조합을 공식적으로 제공합니다. 이 방식이면 `\x1b[A` 같은 하드코딩 대신 `key.name === 'up'` 형태로 분기할 수 있어 ESC/화살표 충돌을 줄일 수 있습니다.

> 출처: [Node.js readline API (emitKeypressEvents)](https://github.com/nodejs/node/blob/main/doc/api/readline.md)

### 2) 커서/라인 제어: 직접 ANSI 문자열보다 `readline.cursorTo/moveCursor/clearLine`

Node는 TTY 출력 제어용 API를 제공합니다. 이 API를 사용하면 팝업 렌더링/삭제 로직을 더 읽기 쉽게 유지하고, 커서 복원 실수를 줄일 수 있습니다.

> 출처: [Node.js readline API (cursorTo, moveCursor, clearLine)](https://github.com/nodejs/node/blob/main/doc/api/readline.md)

### 3) 터미널 리사이즈 대응

`process.stdout`은 `resize` 이벤트를 제공하므로, popup 열린 상태에서 width/height 재계산 후 재렌더링하는 설계를 기본으로 잡아야 잔상을 줄일 수 있습니다.

> 출처: [Node.js tty API (resize event)](https://github.com/nodejs/node/blob/main/doc/api/tty.md)

---

## 구현 결과 요약

- 구현됨
  - autocomplete 상태 객체(`open`, `items`, `selected`, `renderedRows`, `maxRows`) 추가
  - `getCompletionItems(partial, iface)`를 통해 name/desc/args 메타 기반 popup 렌더링
  - 키 바인딩: `↑/↓` 이동, `Tab` 입력 치환, `Enter` 선택 적용(인자 필요 시 공백 포함), `ESC` popup close
  - `process.stdout.on('resize')`에서 prompt + popup 재렌더
  - popup 렌더/클리어 시 커서 save/restore + line clear 기반으로 갱신

---

## 설계 (Phase 1)

## 목표 UX

```text
  ❯ /m
    /model     모델 확인/변경
  > /mcp       MCP 목록/동기화/설치
    /memory    메모리 검색/목록
```

- `>` 라인이 현재 선택 항목
- `Tab`: 선택 항목으로 입력 치환 (`/mcp `)
- `Enter`:
  - 인자 필요 커맨드면 입력만 치환
  - 인자 불필요 커맨드면 즉시 실행
- `ESC`: popup 닫기

## 상태 머신

```text
NORMAL
  └─(input startsWith '/' && no space && matches>0)→ AC_OPEN

AC_OPEN
  ├─ 문자/백스페이스: 목록 재필터
  ├─ up/down: selectedIndex 이동
  ├─ tab: 입력 치환 후 AC_OPEN 유지 또는 종료
  ├─ enter: 선택 적용(즉시실행 or 입력치환) 후 종료
  ├─ esc: 종료
  └─ matches=0 or '/' 제거: 종료
```

## 데이터 구조

```js
const ac = {
  open: false,
  items: [],
  selected: 0,
  renderedRows: 0,
  maxRows: 8,
};
```

## 렌더링 원칙

1. 기존 `redrawPromptLine()` 먼저 실행
2. popup은 항상 prompt 아래에 그리되, footer(`rows-1`, `rows`)를 침범하지 않도록 clamp
3. render 전에 이전 popup 영역 clear
4. 렌더 후 입력 커서 위치 복원

구현 시 API 우선순위:
- 1순위: `readline.cursorTo`, `readline.moveCursor`, `readline.clearLine`
- 2순위: 보조 ANSI (`\x1b[7m` highlight)

---

## 구현 단계 (완료)

### Step 1. raw stdin 기반 키 처리 확장

- 기존 `process.stdin.on('data')` 루프를 유지하고 ESC 시퀀스(`\x1b[A`, `\x1b[B`)를 분기 처리
- `up`, `down`, `tab`, `return`, `escape`, `backspace`에 해당하는 흐름을 raw 문자열 기반으로 매핑

### Step 2. autocomplete 상태/필터 함수 분리

- `updateAutocompleteFromInput()`
- 조건: `/`로 시작 + 공백 없음
- 데이터 소스: `getCompletionItems(partial, 'cli')`

### Step 3. popup render/clear 함수 추가

- `renderAutocomplete()`
- `clearAutocomplete()`
- `renderedRows` 기반으로 정확히 지우기

### Step 4. 키 바인딩 연결

- `up/down`: 선택 이동
- `tab`: 선택값 주입 (`/${cmd} `)
- `enter`: 선택 커맨드 실행 또는 입력 대기
- `esc`: popup 닫기만 수행 (에이전트 stop 동작보다 우선)

### Step 5. resize 안전성

- `process.stdout.on('resize')`에서
  - popup clear
  - `redrawPromptLine()`
  - popup open이면 재렌더

---

## 적용 파일

- `bin/commands/chat.js`
  - autocomplete 상태/렌더/키 핸들링 추가
- `src/commands.js`
  - `getCompletionItems(partial, iface)` export 추가
  - 기존 `getCompletions()`은 `getCompletionItems()`를 활용하도록 정리

---

## 영향 파일

- `bin/commands/chat.js` (주 변경)
- `src/commands.js` (변경 없음, 필요 시 helper export만 최소 추가)

---

## 난이도 / 공수

| 항목                        | 난이도 | 공수    |
| --------------------------- | ------ | ------- |
| keypress 전환               | 🟡      | 35m     |
| 상태/필터 분리              | 🟢      | 20m     |
| popup render/clear          | 🟡      | 45m     |
| 키 바인딩(↑↓ Tab Enter ESC) | 🟡      | 35m     |
| resize/scroll-region 안정화 | 🟠      | 35m     |
| 수동 테스트                 | 🟡      | 25m     |
| 합계                        |        | 약 3.0h |

---

## 리스크와 대응

| 리스크                      | 확률 | 영향 | 대응                          |
| --------------------------- | ---- | ---- | ----------------------------- |
| ESC 단독 vs ESC 시퀀스 충돌 | 보통 | 보통 | `keypress` 이벤트로 구분 처리 |
| footer 침범/잔상            | 보통 | 높음 | clear→redraw→render 순서 고정 |
| 한글 폭 정렬 깨짐           | 보통 | 낮음 | 기존 `visualWidth` 재사용     |
| resize 중 깜박임            | 보통 | 낮음 | 재렌더 debounce 50~80ms       |

---

## 완료 기준 (DoD)

1. `/` 입력 시 popup이 유지되며 입력에 따라 실시간 필터링됨
2. `↑/↓`로 선택 이동 가능
3. `Tab`으로 선택 항목 입력 치환됨
4. `Enter`로 인자 없는 커맨드 즉시 실행됨
5. `ESC`로 popup만 닫히고 입력 버퍼는 보존됨
6. 창 크기 변경 시 잔상 없이 복구됨

---

## 수동 검증

```bash
cd /Users/jun/Developer/new/700_projects/cli-claw
node bin/cli-claw serve
node bin/cli-claw chat
```

1. `/` 입력 -> 전체 후보 표시
2. `/m` -> `/model`, `/mcp`, `/memory` 필터
3. `down`, `up` 이동 확인
4. `tab` 치환 확인
5. `enter` 즉시 실행/입력 치환 분기 확인
6. `esc` 닫기 확인
7. terminal resize 후 잔상 확인
