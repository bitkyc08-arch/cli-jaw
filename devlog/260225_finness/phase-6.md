# Phase 6 (finness): 테마 시스템 + 사이드바 접기

> 완료: 2026-02-25T02:15
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

---

## Part D: 타이포그래피 + 브랜딩 (P5.9, P5.9.1 통합)

### 3단 타이포그래피

| 티어 | 폰트 | 용도 |
|------|------|------|
| Display | `Chakra Petch` | 로고, 섹션 타이틀, 탭, 사이드바 버튼, 배지, 헤더 |
| Body | `Outfit` | 레이블, 본문, 일반 UI |
| Code | `SF Mono` | 입력창, 코드블록 |

### 비주얼 폴리시

- 커스텀 스크롤바 6px (Webkit + Firefox)
- 메시지 `msgSlideIn` 0.2s 등장 애니메이션
- 비대칭 버블 (12px/4px border-radius)
- 사이드바 그라디언트 + inner shadow
- 버튼/카드 hover: `translateY(-1px)` + glow
- 입력 포커스 링: accent 색상 + 2px blur

### 브랜딩

- 🦞 이모지 프론트엔드 전체 제거
- CLI-CLAW: 로고·헤더·타이틀 = **불변 하드코딩**
- Agent Name: 좌측 사이드바, localStorage 기반, 메시지 라벨만 변경
- Phase 99에서 프롬프트 이름 연동 예정

---

## 변경 파일 총괄

| 파일 | 라인 | 변경 요약 |
|------|------|----------|
| `variables.css` | 126L | 3단 폰트 + 사이드바 변수 + 13개 시맨틱 색상 + 라이트 팔레트 + 스크롤바 |
| `layout.css` | 250L | 사이드바 그라디언트/depth + collapse CSS + toggle 버튼 + display font |
| `chat.css` | 404L | 메시지 애니메이션 + 버블 + 포커스 링 + 헤더 flex + stop-btn var |
| `sidebar.css` | 224L | 카드 lift + settings hover + display font + toggle vars |
| `markdown.css` | 149L | 코드/테이블/링크 색상 변수화 |
| `index.html` | 442L | Chakra Petch CDN + 🦞 제거 + Agent Name + ◀/▶ + ☀️/🌙 |
| `sidebar.js` | 42L | **NEW** 사이드바 접기 |
| `theme.js` | 38L | **NEW** 테마 토글 |
| `appname.js` | 43L | **NEW** Agent Name |
| `main.js` | 239L | 3개 모듈 wire |
| `ui.js` | 143L | `getAppName()` 동적 라벨 |

---

## Phase 6.1: 레이아웃 리팩터 + 이모지 정리

### 사이드바 토글 구조
- ◀/▶ 각 사이드바 첫번째 자식으로 배치 (로고 위)
- 접힌 상태: 토글만 표시 (`:first-child` 외 `display:none`)
- 반응형: `@media (max-width: 900px)` 자동 접힘

### 이모지 정리
- 탭 버튼: `🤖 Agents` → `Agents`, `📦 Skills` → `Skills`, `🔧 Settings` → `Settings`
- 서브에이전트 카드: `🤖` → CSS accent dot (8px)
- ROLE_PRESETS: `🎨⚙️📊📝✏️` 전부 제거 → 텍스트만
- 모델 커스텀: `✏️ 직접 입력...` → `직접 입력...`

### 하단 버튼 통일
- `/clear` 포함 전부 `sidebar-hb-btn` 클래스
- `.sidebar-bottom` 컨테이너: `gap: 6px` 균일 간격
- `btn-clear`, `btn-save`: `--font-display` 폰트 통일
