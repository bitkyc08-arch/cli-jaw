# Phase 6 (finness): Web UI 테마 시스템 (Light Mode + Custom Colors)

> 목표: 다크 전용 → 다크/라이트/커스텀 테마 전환 지원 및 좌우 사이드바 접기 기능
> 난이도: 🟡 보통 (CSS 변수 분리와 localStorage 상태 관리가 핵심이며, 기존 로직 이관 자체는 직관적임)

---

## 현재 상태

`variables.css` `:root`에 12개 CSS 변수가 다크 전용으로 하드코딩:
```css
:root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --text: #e4e4ef;
    --text-dim: #6e6e8a;
    --accent: #ff6b6b;
    --accent2: #ffa07a;
    --green: #4ade80;
    --user-bg: #1a1a2e;
    --agent-bg: #0f0f1a;
}
```

추가로 CSS 파일들에 하드코딩 색상이 산재:
| 파일 | 하드코딩 값 | 용도 |
|------|------------|------|
| `layout.css` | `#1a2e1a`, `#2e2a1a` | status-idle/running 배경 |
| `sidebar.css` | `#1a0a0a` | perm-btn/skill-filter active 배경 |
| `chat.css` | `#ef4444`, `#dc2626` | stop 버튼 색상 |
| `markdown.css` | `#0d1117`, `#60a5fa`, `#8b949e` | 코드블록/링크/라벨 |
| `modals.css` | `#555`, `#f55` | toggle off, delete 버튼 |
| `index.html` | hljs `github-dark.min.css` CDN | 코드 하이라이트 테마 |

---

## 작업 계획

### Step 1: CSS 변수 확장 — 테마별 `:root` 분리

#### [MODIFY] `public/css/variables.css`

1. 기존 `:root` → `[data-theme="dark"]` (또는 `:root` 기본 다크 유지)
2. `[data-theme="light"]` 추가:
```css
[data-theme="light"] {
    --bg: #f5f5f7;
    --surface: #ffffff;
    --border: #e0e0e6;
    --text: #1a1a2e;
    --text-dim: #6e6e8a;
    --accent: #e05252;
    --accent2: #d4845a;
    --green: #22c55e;
    --user-bg: #e8e8f0;
    --agent-bg: #f0f0f8;
}
```
3. 하드코딩 색상을 추가 변수로 승격:
```css
:root {
    /* 기존 + 아래 추가 */
    --status-idle-bg: #1a2e1a;
    --status-running-bg: #2e2a1a;
    --active-bg: #1a0a0a;
    --stop-btn: #ef4444;
    --stop-btn-hover: #dc2626;
    --code-bg: #0d1117;
    --link-color: #60a5fa;
    --code-label: #8b949e;
    --toggle-off: #555;
    --delete-color: #f55;
}
```
4. `[data-theme="light"]`에 대응 값 정의

### Step 2: 하드코딩 색상 → 변수 교체

#### [MODIFY] `public/css/layout.css`
- `.status-idle` 배경: `#1a2e1a` → `var(--status-idle-bg)`
- `.status-running` 배경: `#2e2a1a` → `var(--status-running-bg)`

#### [MODIFY] `public/css/sidebar.css`
- `.perm-btn.active` 배경: `#1a0a0a` → `var(--active-bg)`
- `.skill-filter.active` 배경: `#1a0a0a` → `var(--active-bg)`
- `.skill-toggle.off` 배경: `#444` → `var(--toggle-off)`

#### [MODIFY] `public/css/chat.css`
- `.btn-send.stop-mode` 배경: `#ef4444` → `var(--stop-btn)`
- `.btn-send.stop-mode:hover`: `#dc2626` → `var(--stop-btn-hover)`

#### [MODIFY] `public/css/modals.css`
- `.hb-toggle.off`: `#555` → `var(--toggle-off)`
- `.hb-del` color: `#f55` → `var(--delete-color)`

#### [MODIFY] `public/css/markdown.css`
- `pre` 배경: `#0d1117` → `var(--code-bg)`
- `a` color: `#60a5fa` → `var(--link-color)`
- `.code-lang-label` color: `#8b949e` → `var(--code-label)`

### Step 3: 테마 토글 및 사이드바 접기 UI 추가

#### [MODIFY] `public/index.html`
- `<html>` 태그에 `data-theme="dark"` 기본값 지정
- 좌측 사이드바 로고 영역에 **테마 토글** 및 **좌측 접기(`«`)** 버튼 추가:
```html
<div class="sidebar-header">
    <div class="logo">🦞 CLI-CLAW</div>
    <button id="leftSidebarToggle" class="btn-icon">«</button>
</div>
<button id="themeToggle" class="btn-clear">🌙 Dark</button>
```
- 우측 사이드바 상단에 **우측 접기(`»`)** 버튼 추가:
```html
<button id="rightSidebarToggle" class="btn-icon">»</button>
```

#### [MODIFY] `public/css/layout.css`
- 사이드바 축소 상태를 위한 CSS 클래스 추가 (`.collapsed`):
```css
body.left-collapsed { grid-template-columns: 0px 1fr 260px; }
body.right-collapsed { grid-template-columns: 220px 1fr 0px; }
body.left-collapsed.right-collapsed { grid-template-columns: 0px 1fr 0px; }

.sidebar-left, .sidebar-right { transition: width 0.3s ease, padding 0.3s ease; }
.collapsed { overflow: hidden; padding: 0 !important; border: none; }
```
- 사이드바가 접혔을 때 화면 끝에 작게 나타나는 **펼치기 부동 버튼** 추가 (CSS fixed 포지셔닝).

### Step 4: 테마 전환 로직

#### [NEW] `public/js/features/theme.js` (~40L)

#### [NEW] `public/js/features/theme.js` (~50L)

| 함수 | 역할 |
|------|------|
| `initTheme()` | `localStorage.getItem('theme')` 및 사이드바 상태(`leftCollapsed`, `rightCollapsed`) 로드 및 적용 |
| `toggleTheme()` | `data-theme` 토글 + localStorage 저장 + hljs 테마시트 교체 |
| `swapHljsTheme(theme)`| `<link>` href를 `github-dark` ↔ `github` 교체 |
| `toggleLeftSidebar()` | `body.classList.toggle('left-collapsed')` + localStorage 저장 |
| `toggleRightSidebar()`| `body.classList.toggle('right-collapsed')` + localStorage 저장 |

highlight.js 라이트 테마:
```
https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css
```

#### [MODIFY] `public/js/main.js`
- `import { initTheme } from './features/theme.js'` 추가
- `DOMContentLoaded` 시 `initTheme()` 호출

### Step 5: 서버 측 (변경 없음)
- 테마는 순수 클라이언트 CSS/JS → 백엔드 변경 불필요
- `localStorage`에 저장 → DB 불필요

---

## 완료 기준

| 항목 | 조건 |
|------|------|
| 토글 동작 | 버튼 클릭 → 즉시 다크↔라이트 전환, 깜빡임 없음 |
| 새로고침 유지 | `localStorage` 기반 테마 복원 |
| 하드코딩 0건 | CSS에 `#hex` 직접 참조 없음 (변수로 100% 치환) |
| hljs 연동 | 코드블록 하이라이트 테마도 동기 전환 |
| 확장성 | `setTheme('custom-name')` 호출로 커스텀 팔레트 추가 가능 |
