# (fin) 프론트엔드 모듈화 (Phase 11)

> `public/index.html` 모놀리스(2,374L) → 18개 모듈 파일로 분리

## 결과

```
Before: 1 file, 2,374 lines (95KB), inline JS + CSS + onclick ×50
After:  18 files, 2,504 lines total, ES Modules + External CSS

index.html: 2,374L → 416L (▼82%)
```

## 구조

```
public/
├── index.html (416L)          ← 순수 HTML 뼈대
├── css/ (860L)
│   ├── variables.css (47L)    ← :root 변수, 리셋
│   ├── layout.css (162L)      ← 사이드바, 탭
│   ├── chat.css (265L)        ← 채팅, 메시지, 타이핑
│   ├── sidebar.css (215L)     ← 설정, 스킬 카드
│   └── modals.css (171L)      ← 모달, 하트비트
└── js/ (1,228L)
    ├── main.js (198L)         ← 진입점 + getElementById → addEventListener
    ├── state.js (16L)         ← 전역 상태 공유 객체
    ├── constants.js (23L)     ← MODEL_MAP, ROLE_PRESETS
    ├── render.js (20L)        ← escapeHtml, renderMarkdown
    ├── ui.js (138L)           ← setStatus, addMessage, tabs
    ├── ws.js (41L)            ← WebSocket 연결 + 메시지 라우팅
    └── features/
        ├── chat.js (111L)     ← 메시지 전송, 파일 첨부, 드래그
        ├── settings.js (351L) ← 설정, CLI 상태, Telegram, MCP
        ├── skills.js (65L)    ← 스킬 로드/필터/토글
        ├── employees.js (92L) ← 서브에이전트 CRUD
        ├── heartbeat.js (83L) ← 하트비트 모달/작업
        └── memory.js (90L)    ← 메모리 모달/설정
```

## 핵심 설계

1. **Native ES Modules** — `<script type="module">`, 번들러 없음
2. **`state.js` 싱글턴** — 모든 모듈이 하나의 객체 참조 import
3. **Event Delegation** — 동적 요소는 `data-*` 속성 + 부모 addEventListener
4. **Lazy Loading** — 탭 진입 시 `import()` 동적 로딩
5. **`modulepreload`** — 크리티컬 모듈 3개 (state, ws, ui) 프리로드
6. **Express static** — `app.use(express.static('public'))` 자동 서빙, 변경 불필요

## inline onclick 제거

- Before: `onclick="sendMessage()"` × 50개
- After: `main.js`에서 `getElementById` + `addEventListener`
- 동적 요소: `data-skill-id`, `data-emp-delete`, `data-hb-toggle` 등으로 이벤트 위임