# Phase 7.2 — Chat Textarea Auto-Expand

> 채팅 입력창이 1줄 고정이라 긴 입력 시 텍스트가 잘리는 문제. 입력에 따라 **위로 자동 확장** (최대 8줄).

## 변경 파일

| 파일 | 변경 내용 |
|------|-----------|
| `public/css/chat.css` | `.chat-input`에 `max-height: 192px`, `overflow-y: auto`, `transition` 추가 |
| `public/js/features/chat.js` | `autoResize()`, `initAutoResize()`, `resetInputHeight()` 함수 추가 + 전송 후 높이 리셋 3곳 |
| `public/js/main.js` | `initAutoResize` import + `bootstrap()` 내 호출 |

## 핵심 로직

```js
// textarea가 input 이벤트마다 scrollHeight에 맞춰 확장
function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}
```

- **CSS `max-height: 192px`** → 8줄 이상부터 스크롤
- **`resetInputHeight()`** → 전송 후 1줄로 복귀
- 슬래시 커맨드 / 파일 첨부 / 일반 전송 모두 리셋 적용

## 검증

- [x] `npm test` — 116/116 통과 (0 fail)
- [x] Shift+Enter 줄바꿈 시 입력창 위로 확장
- [x] 8줄 초과 시 스크롤바 표시
- [x] 메시지 전송 후 1줄로 복귀
