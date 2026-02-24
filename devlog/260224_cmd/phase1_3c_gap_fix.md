---
created: 2026-02-24
tags: [cli-claw, autocomplete, gap-fix, scroll-region]
aliases: [Phase 1.3c 팝업 갭 수정]
---
# (fin) Phase 1.3c: Autocomplete 팝업 갭/잔상 수정

> 상태: ✅ 적용 완료
> 날짜: 2026-02-24
> 범위: `bin/commands/chat.js` (CLI raw mode)
> 선행조건: Phase 1.2b
> 후속 영향: Phase 4(windowed autocomplete) 안정성 기반

## 문제 요약

`/` 입력으로 popup을 띄운 뒤 Backspace로 닫으면:
1. 옛 프롬프트 `› /`가 위에 남음
2. 중간에 빈 줄 다수 발생
3. 새 프롬프트 `› ▌`가 아래에 별도 생성

## 원인 분석

기존 `setPromptLift(n)`은 popup 공간 확보를 위해 **프롬프트를 위로 올림** (CSI A).
이때 커서가 배너/응답 텍스트 영역으로 진입하여 기존 내용을 **덮어쓰기**.

popup 닫을 때 `setPromptLift(0)`으로 커서를 내리면:
- 올렸던 자리의 옛 프롬프트 텍스트가 안 지워짐 → 잔상
- 덮어쓴 배너/응답 내용이 복구 불가 → 콘텐츠 소실

핵심: **위로 올리면 기존 콘텐츠를 파괴**하고, 내릴 때 복구할 수 없다.

## 수정 전략: `ensureSpaceBelow(n)`

방향 전환: 프롬프트를 올리지 않고, **아래에 공간을 만드는 방식**.

> 코드 주석에서는 `Phase 1c`로 표기되어 있으며, 이 문서의 `Phase 1.3c`와 동일 변경을 의미한다.

```js
function ensureSpaceBelow(n) {
    if (n <= 0) return;
    for (let i = 0; i < n; i++) process.stdout.write('\n');
    process.stdout.write(`\x1b[${n}A`);
}
```

동작:
1. `\n` N회 출력 → scroll region 내에서 자연스럽게 콘텐츠 위로 밀림
2. CSI A로 커서 원위치 복귀
3. 아래로 N줄 공간 확보 → popup 렌더 가능

장점:
- 위의 콘텐츠를 **덮어쓰지 않음** (터미널 자연 스크롤)
- 닫을 때 별도 복구 불필요 (`clearAutocomplete()`만으로 충분)
- 공간이 이미 충분하면 스크롤 안 됨 (빈 줄 통과만)

## 제거된 코드

- `ac.liftedRows` 상태 필드
- `setPromptLift()` 함수 전체
- `closeAutocomplete()`의 `setPromptLift(0)` 호출
- `redrawInputWithAutocomplete()`의 조건부 lift 로직

## 추가된 코드

- `ensureSpaceBelow(n)` 함수 (5줄)
- `redrawInputWithAutocomplete()`에서 `if (next.open) ensureSpaceBelow(next.visibleRows)` 1줄

## 수동 검증

```bash
cd /Users/jun/Developer/new/700_projects/cli-claw
node bin/cli-claw chat
```

1. `/` → popup 표시 확인
2. Backspace → popup 제거, 잔상/빈줄 없음 확인
3. 다시 `/` → popup 재표시 확인
4. 반복 20회 → 안정성 확인
5. `/m` → 필터링 상태에서 Backspace → 정상 복귀

## 변경 기록

- 2026-02-24 시도 1: `setPromptLift` 전체 제거 → popup 그릴 공간 없어짐 ❌
- 2026-02-24 시도 2: `setPromptLift` 유지 + 내릴 때 옛 프롬프트 `\r\x1b[2K` → 배너 콘텐츠 소실 ❌
- 2026-02-24 시도 3: `ensureSpaceBelow(n)` 도입 — `\n` 자연 스크롤 ✅
