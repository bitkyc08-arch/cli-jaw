# 멀티 파일 인풋 구현

> Date: 2026-02-25

## 개요
기존 단일 파일 첨부(`state.attachedFile`)를 N개 파일 지원으로 변경.
백엔드 변경 없이 프론트엔드만 수정.

## 수정 파일 (5개)

| 파일 | 변경 내용 |
|------|----------|
| `state.js` | `attachedFile: null` → `attachedFiles: []` |
| `chat.js` | 전면 재작성: `attachFiles()`, `uploadAllFiles()`, `clearAttachedFiles()`, `removeAttachedFile(idx)` |
| `index.html` | `<input multiple>` 추가, 파일 프리뷰를 chip-list 구조로 변경 |
| `chat.css` | `.file-chip` 스타일 추가 (pill 형태, 개별 ✕ 제거 버튼) |
| `main.js` | import 변경 + 이벤트 위임(`data-file-idx`) |

## 핵심 설계

### 백엔드 무변경
- `/api/upload`는 기존처럼 1개 파일 처리
- 프론트에서 N개 파일을 `Promise.all`로 병렬 업로드
- 각 업로드 결과 path를 프롬프트에 `[attached: path1, path2, ...]` 형태로 주입

### 칩 프리뷰
```html
<div class="file-chip">
  <span class="file-chip-name">photo.png</span>
  <button class="file-chip-remove" data-file-idx="0">✕</button>
</div>
```

### 드래그 앤 드롭
기존 `files[0]`만 취하던 것 → `[...e.dataTransfer.files]` 전체 배열로 변경.

## 커밋
- `state.js` ~ `main.js` 수정: 이전 대화에서 구현
- CSS chip 스타일 추가 포함
