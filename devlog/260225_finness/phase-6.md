# Phase 6 (finness): 테마 시스템 + 사이드바 접기

> 목표: 다크/라이트 테마 전환 + 좌우 사이드바 접기/펼치기
> 디자인: `skills_ref/dev-frontend` — Color & Theme, Spatial Composition, Motion

---

## 난이도: ★★★☆☆ (중), ~3-4시간

---

## Part A: 사이드바 접기/펼치기

> "Spatial Composition — Unexpected layouts. Generous negative space OR controlled density."

### 현재 → 목표

```
펼침:  [220px 사이드바] [  채팅 1fr  ] [260px 사이드바]
접힘:  [48] [        채팅 극대화        ] [48]
```

### 작업

#### [MODIFY] `variables.css`
- `--sidebar-left-w`, `--sidebar-right-w`, `--sidebar-collapsed-w` 변수 추가
- `body` grid를 변수 기반으로 전환

#### [MODIFY] `layout.css`
- `body.left-collapsed`, `body.right-collapsed` 클래스별 접힌 상태 스타일
- 접힌 사이드바: 텍스트 숨김, 아이콘만 표시
- `transition: grid-template-columns 0.25s ease`

#### [MODIFY] `index.html`
- 좌측 로고 옆 ◀ 버튼, 우측 탭바 ▶ 버튼

#### [NEW] `js/features/sidebar.js` (~30L)
- `initSidebar()` — localStorage 복원 + 이벤트 바인딩
- `toggleLeft()` / `toggleRight()` — classList 토글 + 화살표 반전 + 저장

---

## Part B: 테마 (Light Mode + Custom Colors)

> "Color & Theme — CSS variables for consistency. Dominant colors with sharp accents."

### 작업

#### [MODIFY] `variables.css`
- 하드코딩 색상 15곳 → CSS 변수 승격 (`--code-bg`, `--link-color`, `--stop-btn` 등)
- `[data-theme="light"]` 팔레트 추가 (warm gray 기반)

#### [MODIFY] 5개 CSS 파일
- `#hex` 직접 참조 → `var(--변수명)` 치환

#### [MODIFY] `index.html`
- `<html data-theme="dark">` 기본값
- 사이드바 App Name 옆 테마 토글 버튼 (🌙↔☀️)
- hljs CDN: `github-dark` ↔ `github` 동적 교체

#### [NEW] `js/features/theme.js` (~40L)
- `initTheme()` — localStorage 또는 `prefers-color-scheme` 감지
- `toggleTheme()` — data-theme 토글 + hljs 시트 교체 + 버튼 텍스트

---

## Part C: 디자인 디테일 (dev-frontend)

> "Motion — High-impact moments: one well-orchestrated page load."

- 사이드바 접기 슬라이드: `0.25s ease` transform
- 테마 전환: `transition: background 0.3s, color 0.2s` (깜빡임 방지)
- 라이트 모드 코드블록: GitHub 스타일 `#f6f8fa` 배경

---

## 완료 기준

| 항목 | 조건 |
|------|------|
| 사이드바 접기 | ◀/▶ → 48px 슬라이드, localStorage 유지 |
| 테마 토글 | 🌙↔☀️ 즉시 전환, 새로고침 유지 |
| 하드코딩 0건 | CSS `#hex` 직접 참조 없음 |
| hljs 연동 | 코드블록 테마 동기 전환 |
