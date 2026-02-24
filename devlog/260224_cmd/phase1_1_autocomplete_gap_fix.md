# (fin) Phase 1.1: Autocomplete Gap/Blank-Line Fix

> 상태: ✅ 적용 완료
> 날짜: 2026-02-24
> 범위: `bin/commands/chat.js` (CLI raw mode)

## 문제 요약

`/` 입력으로 autocomplete popup을 띄운 뒤, `/`를 지워 popup을 닫으면 입력 아래에 큰 빈 영역이 남습니다. 기대 동작은 "popup이 사라지고 즉시 원래 프롬프트 레이아웃으로 복귀"입니다.

현재 재현 경로:
1. `cli-claw chat`
2. `/` 입력 (popup open)
3. `Backspace`로 `/` 삭제 (popup close)
4. 빈 줄이 여러 줄 남음

---

## 원인 분석

현 구현의 `clearAutocomplete()` / `renderAutocomplete()`는 popup 라인을 다룰 때 `\n`(line feed)로 아래 줄로 이동합니다.

- `\n`은 scroll region 내부에서 실제 줄 이동/스크롤을 유발할 수 있음
- 커서 `save/restore`를 해도 이미 발생한 스크롤/빈 줄 생성은 되돌아가지 않음
- 결과적으로 popup close 이후 화면이 원상복구되지 않고 "공백 블록"이 누적됨

관련 코드 위치:
- `bin/commands/chat.js`의 `clearAutocomplete()` (`\n\x1b[2K` 반복)
- `bin/commands/chat.js`의 `renderAutocomplete()` (`\n\x1b[2K` 반복)

---

## Phase 1.1 목표

1. popup open/close를 반복해도 레이아웃 누수(빈 줄 누적)가 없어야 함
2. `/` -> Backspace 한 번으로 즉시 정상 프롬프트로 복구되어야 함
3. resize, command 실행, stream 출력 후에도 popup 정리 상태가 일관되어야 함

---

## 수정 전략

## A. newline 기반 이동 제거

`\n`을 사용한 렌더/클리어를 모두 제거하고,
- cursor save/restore (`\x1b[s`, `\x1b[u`)
- cursor down (`\x1b[{n}B`) 또는 `readline.moveCursor`
- line clear (`\x1b[2K` 또는 `readline.clearLine`)
만 사용해서 popup 영역을 갱신합니다.

핵심: "줄을 새로 만들지 않고 기존 줄에 그리기".

## B. popup clear를 절대/상대 좌표 기반으로 고정

`for i in 1..renderedRows` 반복에서:
- 저장된 기준 커서에서 i줄 아래로 이동
- 해당 줄 `\r\x1b[2K`
- 다시 기준점 복귀

이 흐름이면 scroll region이 밀리지 않습니다.

## C. popup 갱신 단일 진입점 유지

아래 경로는 모두 동일한 정리 순서로 강제:
1. 문자 입력/Backspace
2. ESC close
3. Enter submit
4. command 시작 전
5. resize

권장 순서: `clearAutocomplete -> redrawPromptLine -> maybeRenderAutocomplete`.

## D. render row clamp

`maxShow`를 다음과 같이 제한:
- `ac.maxRows`
- `ac.items.length`
- `scroll region 하단 여유(rows-2 기준)`

하단 footer 영역 침범을 방지합니다.

---

## 구현 체크리스트

- [x] `clearAutocomplete()`에서 `\n` 제거
- [x] `renderAutocomplete()`에서 `\n` 제거
- [x] popup clear/render를 커서 이동 기반으로 통일
- [x] `redrawInputWithAutocomplete()` 시작 시 stale popup 선삭제 추가
- [x] `handleResize()`에서 stale popup 정리 후 재렌더
- [ ] `/ -> Backspace` 수동 회귀 테스트 (사용자 수행 예정)

---

## 실제 적용 내용

1. `clearAutocomplete()` / `renderAutocomplete()`의 줄 이동을 newline 기반에서 `CSI B` + `\r\x1b[2K` 기반으로 통일했습니다.
2. `redrawInputWithAutocomplete()`에서 prompt redraw 전에 `clearAutocomplete()`를 강제하여, close 타이밍 잔상이 남지 않도록 했습니다.
3. autocomplete close 시 상태 초기화(`open/items/selected/renderedRows`)는 기존 로직을 유지하면서 stale 렌더만 확실히 제거하도록 조정했습니다.

---

## 수동 검증

```bash
cd /Users/jun/Developer/new/700_projects/cli-claw
node bin/cli-claw.js serve
node bin/cli-claw.js chat
```

1. `/` -> popup open
2. Backspace -> popup close, 공백 블록 없어야 함
3. `/, Backspace`를 10회 반복 -> 누수 없어야 함
4. `/m`, `up/down`, `ESC` -> 정상 close
5. popup 열린 상태에서 창 resize -> 잔상/공백 없어야 함
6. popup 열린 상태 Enter 실행 후 -> 프롬프트 정상 복귀

---

## 예상 공수

- 코드 수정: 30~45m
- 수동 회귀 테스트: 20m
- 합계: 약 1.0h

---

## 참고 근거

Node TTY 입력/커서 제어 관련 권장 API:
- `readline.emitKeypressEvents`, `setRawMode`
- `readline.cursorTo`, `readline.moveCursor`, `readline.clearLine`
- `tty` resize event

> 출처: [Node.js readline API](https://github.com/nodejs/node/blob/main/doc/api/readline.md)
> 출처: [Node.js tty API](https://github.com/nodejs/node/blob/main/doc/api/tty.md)
