# Frontend — public/ (26 files, ~4500L)

> Web UI — Vanilla HTML + CSS + ES Modules. CDN: marked, highlight.js, KaTeX, Mermaid.
> 3단 폰트: Chakra Petch(display) + Outfit(body) + SF Mono(code).
> 듀얼 테마: dark(기본)/light, 반응형 사이드바 접기(900px).

---

## 파일 구조

```text
public/
├── index.html            ← 뼈대 (459L, CDN 4개 + data-theme + ◀/▶ 토글 + multi-file chip)
├── css/                  ← 6 files (1355L)
│   ├── variables.css     ← 커스텀 프로퍼티, 3단 폰트, 라이트 팔레트, 사이드바 변수 (126L)
│   ├── layout.css        ← 사이드바 그라디언트 + 토글 absolute + collapse + 반응형 (281L)
│   ├── chat.css          ← 채팅 버블/애니메이션 + flex 헤더 + stop-btn var + auto-expand + file-chip (467L)
│   ├── sidebar.css       ← 설정/스킬 카드 hover + display font (224L)
│   ├── modals.css        ← 모달, 하트비트 카드 (171L)
│   └── markdown.css      ← 렌더링 (테이블·코드·KaTeX·Mermaid) + 시맨틱 var + copy 버튼 (161L)
└── js/                   ← 16 files (~2300L)
    ├── main.js           ← 앱 진입점 + 5개 모듈 wire + 인덱스 탭 전환 (281L)
    ├── state.js          ← 공유 상태 모듈 (attachedFiles 배열) (16L)
    ├── constants.js      ← CLI_REGISTRY 동적 로딩 + ROLE_PRESETS (이모지 제거) (119L)
    ├── render.js         ← marked+hljs+KaTeX+Mermaid 렌더러 + rehighlightAll + copy delegation + sanitize + i18n (220L)
    ├── ui.js             ← DOM 유틸 + stop-mode + getAppName() + finalizeAgent guard + user 마크다운 (151L)
    ├── ws.js             ← WebSocket + 메시지 라우팅 + orchestrate_done (64L)
    └── features/
        ├── chat.js       ← 전송, multi-file 첨부, chip 프리뷰, 드래그앤드롭, 멈춤, 큐, auto-expand (207L)
        ├── settings.js   ← 설정 + CLI 상태 + perCli (5개 CLI) (524L)
        ├── skills.js     ← 로드, 토글, 필터 (69L)
        ├── employees.js  ← 직원(employee) CRUD (CSS dot, 이모지 없음) (106L)
        ├── heartbeat.js  ← 하트비트 모달/작업 (83L)
        ├── memory.js     ← 메모리 모달/설정 (90L)
        ├── sidebar.js    ← [NEW] 사이드바 접기 (이중 모드: wide=collapsed, narrow=expanded) (88L)
        ├── theme.js      ← [NEW] 다크/라이트 테마 토글 + hljs 스타일시트 스와프 (38L)
        ├── appname.js    ← [NEW] Agent Name 커스텀 (localStorage, 메시지 라벨) (43L)
        └── slash-commands.ts ← 슬래시 커맨드 드롭다운 (220L)
```

---

## 모듈 구성

### Core Layer

| 모듈 | 역할 | 라인 |
|------|------|------|
| `main.js` | 앱 진입점, 이벤트 바인딩, 인덱스 탭 전환 | 281 |
| `state.js` | 공유 상태 | 16 |
| `constants.js` | CLI_REGISTRY 동적 로딩 + ROLE_PRESETS | 119 |

### Utility Layer

| 모듈 | 역할 | 라인 |
|------|------|------|
| `render.js` | marked+hljs+KaTeX+Mermaid 렌더러 + rehighlightAll + copy + sanitize + i18n | 220 |
| `ui.js` | DOM 유틸 + stop-mode + finalizeAgent guard + user 마크다운 | 151 |
| `ws.js` | WebSocket + 메시지 라우팅 + orchestrate_done | 64 |

### Features Layer

| 모듈 | 역할 | 라인 |
|------|------|------|
| `chat.js` | 전송, multi-file 첨부, chip 프리뷰, 개별제거, 드래그앤드롭, auto-expand | 207 |
| `settings.js` | 설정 패널 + perCli (5개 CLI) | 524 |
| `skills.js` | 스킬 카드 UI | 69 |
| `employees.js` | 직원(employee) CRUD (CSS dot) | 106 |
| `heartbeat.js` | 하트비트 모달 | 83 |
| `memory.js` | 메모리 모달 | 90 |
| `sidebar.js` | 사이드바 접기 (이중 모드 responsive) | 88 |
| `theme.js` | 다크/라이트 테마 + hljs 스와프 | 38 |
| `appname.js` | Agent Name 커스텀 | 43 |
| `slash-commands.ts` | 슬래시 커맨드 드롭다운 | 220 |

---

## CSS 시스템

| 파일 | 역할 | 라인 |
|------|------|------|
| `variables.css` | 3단 폰트 + 시맨틱 색상 + 라이트 팔레트 + 사이드바 변수 | 126 |
| `layout.css` | 사이드바 그라디언트 + 토글 absolute + collapse/반응형 | 281 |
| `chat.css` | 채팅 버블 + 애니메이션 + flex 헤더 + auto-expand + file-chip | 467 |
| `sidebar.css` | 설정/스킬 카드 hover + display font | 224 |
| `modals.css` | 모달 + 하트비트 카드 | 171 |
| `markdown.css` | 마크다운 렌더링 + 시맨틱 색상 var + copy 버튼 스타일 | 161 |

### 테마

| 기능 | 구현 |
|------|------|
| 다크/라이트 | `[data-theme="light"]` vs `:root` (기본 다크) |
| 13개 시맨틱 변수 | `--stop-btn`, `--code-bg`, `--link-color` 등 |
| hljs 연동 | `theme.js`가 `#hljsTheme` link href 스와프 |
| 토글 UI | 챗 헤더 ☀️/🌙 |
| localStorage | 새로고침 유지 |

### 사이드바 접기

| 기능 | 구현 |
|------|------|
| 토글 위치 | `position:absolute;top:10px` 좌=left, 우=right |
| Wide (>900px) | `left-collapsed`/`right-collapsed` 토글 |
| Narrow (≤900px) | CSS 자동 접힘 → `left-expanded` 로 오버라이드 |
| 아이콘 | ◀/▶ 실제 상태 반영 |
| localStorage | wide 상태만 저장, narrow는 CSS 기본 |

---

## Phase 6 변경 타임라인

| Phase | 내용 |
|-------|------|
| 6 | 사이드바 접기 + 테마 시스템 + 시맨틱 변수 |
| 6.1 | 레이아웃 리팩터 + 이모지 정리 (탭, 직원, ROLE_PRESETS) |
| 6.2 | 토글 absolute 통일 + 반응형 이중 모드 + collapsed/expanded 충돌 수정 |
| 7.2 | 채팅 입력창 auto-expand (최대 8줄, 전송 후 리셋) |
| 16 | orchestrate_done WS 핸들러 추가 + finalizeAgent 이중 호출 방지 (debounce 500ms) |
| 16+ | hljs CDN v11 수정 + `rehighlightAll()` lazy 폴링 + 코드 복사 버튼 event delegation + `markdown.css` copy 스타일 |
| Bug 2.1 | 유저 메시지 `renderMarkdown()` 적용 (기존: `escapeHtml()` → `renderMarkdown()`) |
| i18n Fix | 탭 전환 textContent 영어 하드코딩 → 인덱스 기반 매칭 (다국어 호환) |
| i18n Fix | render.js/settings.js 하드코딩 한국어 4곳 → `t()` i18n 호출 + `escapeHtml(t)` 파람메터 충돌 수정 |
| Multi-file | `attachedFile` → `attachedFiles[]`, chip 프리뷰, 개별 제거, 병렬 업로드, `<input multiple>` |
