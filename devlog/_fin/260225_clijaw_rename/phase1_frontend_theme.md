# Phase 1: Frontend Theme — Red → Arctic Cyan + UI Polish

> Status: **✅ 완료** (2025-02-25 17:13)
> Parent: `260225_clijaw_rename/plan.md`

---

## 결과 요약

### 1. 색상 변경: Arctic Cyan 채택

| 모드 | accent (이전) | accent (이후) | accent2 (이전) | accent2 (이후) |
|------|-------------|-------------|--------------|--------------|
| Dark | `#ff6b6b` | `#22d3ee` | `#ffa07a` | `#06b6d4` |
| Light | `#e04848` | `#0891b2` | `#d35f3a` | `#0e7490` |

`variables.css` 4줄 변경 → 39곳 자동 반영. `--stop-btn`, `--delete-color`은 빨강 유지 (UX 관례).

### 2. 리네임 (프론트엔드)

| 파일 | 변경 |
|------|------|
| `index.html` | `<title>CLI-JAW</title>`, 로고 `CLI-JAW`, 헤더 `CLI-JAW ●`, agent name default |
| `appname.js` | `DEFAULT_NAME = 'CLI-JAW'` |

### 3. 사이드바 버벅임 수정

| 파일 | 변경 | 효과 |
|------|------|------|
| `variables.css` | `cubic-bezier(0.4,0,0.2,1)` + `will-change` | GPU 힌트, Material easing |
| `layout.css` | `display:none` → `opacity:0` + `pointer-events:none` | reflow 제거, fade 전환 |
| `layout.css` | `contain: layout style` | 사이드바 reflow 격리 |
| `layout.css` | `overflow: hidden` (collapsed) | 콘텐츠 잔여물 방지 |

### 4. 디자인 개선

| 항목 | 변경 |
|------|------|
| 하드코딩 `#1a0a0a` | `color-mix(in srgb, var(--accent) 10%, var(--bg))` (sidebar.css ×2) |
| 로고 글로우 | `text-shadow: 0 0 20px ...` (layout.css) |
| 스크롤바 hover | accent 틴팅 `color-mix()` (variables.css) |
| 채팅 영역 구분 | `border-left` 추가 (chat.css) |
| 테마 토글 | 이모지 ☀️/🌙 → Pill 스위치 (moon crescent ↔ amber sun) |
| Quota 버튼 높이 | `align-items:stretch` + SVG refresh 아이콘, select 패딩 통일 |

---

## 수정 파일 목록

| 파일 | 주요 변경 |
|------|----------|
| `public/css/variables.css` | accent 색상, easing, will-change, scrollbar tint |
| `public/css/chat.css` | pill theme switch, border-left |
| `public/css/layout.css` | opacity 전환, contain, 로고 글로우 |
| `public/css/sidebar.css` | `#1a0a0a` → `color-mix()` ×2 |
| `public/index.html` | CLI-JAW 리네임 ×4, pill switch HTML, quota 높이, SVG refresh |
| `public/js/features/theme.js` | `classList.toggle('is-light')` (SVG/emoji 제거) |
| `public/js/features/appname.js` | `DEFAULT_NAME = 'CLI-JAW'` |

---

## 테스트 페이지

`public/theme-test.html` — 4가지 후보 비교용 (Arctic Cyan 채택 후 보존용)
