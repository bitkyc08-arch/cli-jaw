# Phase 5 (finness): Web UI 마크다운 렌더링 개선

> 완료: 2026-02-25T01:22

---

## 변경 전

`render.js` 21줄 regex 파서 — 코드블록(언어무시), 인라인코드, 볼드, 헤딩만 지원.
테이블, 리스트, 링크, 인용, 수학식, 다이어그램 전부 미지원.

---

## 도입 라이브러리 (CDN defer)

| 라이브러리 | 버전 | 용도 |
|-----------|------|------|
| marked | v14 | GFM 마크다운 → HTML |
| highlight.js | v11 | 코드블록 구문 강조 |
| KaTeX | v0.16 | 수학식 ($, $$) |
| Mermaid | v11 | 다이어그램 |

---

## 삽질 기록 🔥

### 1. CSS selector 불일치 (`.msg-body` vs `.msg-content`)
- `markdown.css`에서 `.msg-body` 사용했으나 실제 DOM은 `<div class="msg-content">`
- **증상**: CSS 전혀 적용 안 됨 — 테이블 border 없고 코드블록 스타일 없음
- **수정**: `.msg-body` → `.msg-content` 전체 치환
- 커밋: `4e80299`

### 2. marked.js v14 커스텀 렌더러 API 변경
- `renderer.table = function({ header, body })` 로 오버라이드 시도
- marked v14는 토큰 기반 렌더러로 변경 → header/body가 Object로 전달
- **증상**: 테이블이 `[object Object],[object Object]undefined` 로 출력
- **수정**: 커스텀 렌더러 삭제, `marked.parse()` 결과에 regex로 `<div class="table-wrapper">` 감싸기
- 커밋: `6bc77fa`

### 3. 테이블 `display: block` → 줄 삐뚤빼뚤
- 가로 스크롤을 위해 `table { display: block }` 적용
- thead/tbody/tr에 `display: table; width: 100%` 강제 → 셀 너비 불일치로 border 어긋남
- **수정**: `display: block` 제거, `.table-wrapper` div로 감싸서 overflow-x 처리
- 커밋: `fa00447`

### 4. 테이블 border 색상 안 보임
- 처음 `#3b3f47` → dark 배경과 거의 동일
- 형광 초록 `#4ade80` → 너무 강렬
- **최종**: 시안 `#06b6d4` + 셀 `rgba(6,182,212,0.35)` + 헤더 하단 `2px solid`
- 커밋: `4299697`

---

## 최종 파일 변경

### [MODIFY] `public/index.html`
- CDN `<script defer>` 4개 + `<link>` CSS 2개

### [NEW] `public/css/markdown.css`
- 테이블 (시안 border), 코드블록, blockquote, 리스트, 링크, KaTeX, Mermaid

### [REWRITE] `public/js/render.js` (21L → 140L)
- `stripOrchestration()` — subtask JSON 제거
- `ensureMarked()` — marked + hljs + mermaid 초기화
- `renderer.code()` — mermaid 분기, hljs 하이라이팅
- `renderMath()` — KaTeX block/inline
- `renderMermaidBlocks()` — DOM 삽입 후 비동기 렌더
- `renderFallback()` — CDN 실패 시 기존 regex
- `renderMarkdown()` — 메인 export

### [MODIFY] `public/css/chat.css`
- `.msg` 클래스에 `white-space: pre-wrap` (기존 유지)

---

## 커밋 히스토리

| 커밋 | 내용 |
|------|------|
| `38c2a38` | feat: marked+hljs+katex+mermaid CDN 도입 |
| `178549a` | fix: mermaid 에러 표시, nested fence fallback |
| `bc0d31a` | fix: 테이블 border 색상 (#3b3f47) |
| `c1510cc` | fix: 형광 초록 border + 동적 크기 |
| `4e80299` | fix: CSS selector `.msg-body` → `.msg-content` |
| `fa00447` | fix: display:block 삐뚤 → table-wrapper div |
| `6bc77fa` | fix: [object Object] 버그 — 커스텀 렌더러 제거 |
| `4299697` | style: 시안 형광 border 최종 적용 |
