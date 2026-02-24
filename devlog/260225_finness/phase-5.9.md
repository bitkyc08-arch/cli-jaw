# Phase 5.9 (finness): Web UI 비주얼 폴리시

> 완료: 2026-02-25T01:35
> 참고: `skills_ref/dev-frontend` — 타이포그래피, 컬러, 모션, 공간, 디테일

---

## 현재 문제점 진단

| 영역 | 현상 | dev-frontend 원칙 위반 |
|------|------|----------------------|
| **타이포그래피** | 전체 UI가 `SF Mono / JetBrains Mono` 모노스페이스 — 사이드바·헤더·버튼 포함 | "Choose fonts that are beautiful, unique, interesting" |
| **깊이감** | 모든 요소 flat, `box-shadow` 0건 | "Create atmosphere and depth" |
| **모션** | 사이드바 탭 전환·메시지 등장 시 전환 효과 없음 | "Micro-interactions, staggered reveals" |
| **스크롤바** | 시스템 기본 스크롤바 — 다크 UI에서 돌출됨 | "Meticulously refined in every detail" |
| **hover 상태** | 대부분 `color` 변경만 — 물리적 피드백 없음 | "Hover states that surprise" |
| **채팅 버블** | 평평한 박스, 등장 애니메이션 없음 | "High-impact moments" |
| **구분선** | 전부 1px solid `var(--border)` — 시각적 단조로움 | "Controlled density" |

---

## 설계 원칙

1. **기존 HTML 구조 유지** — 클래스명·ID·JS 바인딩 **일절 변경 없음**
2. **CSS 전용** — 모든 개선은 CSS 추가/수정만으로 달성
3. **점진적 개선** — 브라우저 미지원 시 기존과 동일하게 동작
4. **성능** — GPU 가속 속성만(`transform`, `opacity`), `will-change` 최소화

---

## 작업 계획

### 1. 타이포그래피 듀얼 스택

#### [MODIFY] `public/index.html`

Google Fonts CDN 추가 (display=swap으로 FOUT 방지):
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
```

#### [MODIFY] `public/css/variables.css`

```css
:root {
    /* 기존 변수 유지 + 추가 */
    --font-ui: 'Outfit', -apple-system, system-ui, sans-serif;
    --font-mono: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
}

body {
    font-family: var(--font-ui);   /* ← monospace에서 변경 */
}
```

> **적용 범위:**
> - UI 전반 (사이드바, 탭, 버튼, 레이블): `var(--font-ui)` = Outfit
> - 코드/입력/메시지 본문: `var(--font-mono)` = SF Mono (유지)

#### [MODIFY] `public/css/chat.css`
```css
.chat-input {
    font-family: var(--font-mono);  /* 코드 입력은 모노 유지 */
}
```

#### [MODIFY] `public/css/markdown.css`
```css
.msg-body code, .msg-body pre code {
    font-family: var(--font-mono);  /* 코드블록 모노 유지 */
}
```

**결과:** UI 레이블은 깔끔한 산세리프, 코드는 모노 — 시각적 계층 생김

---

### 2. 깊이감 + 미세 그라디언트

#### [MODIFY] `public/css/layout.css`

사이드바에 미세한 inner shadow + 그라디언트:
```css
.sidebar-left {
    background: linear-gradient(180deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 95%, #000) 100%);
    box-shadow: inset -1px 0 0 var(--border);
}

.sidebar-right {
    background: linear-gradient(180deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 95%, #000) 100%);
    box-shadow: inset 1px 0 0 var(--border);
}
```

#### [MODIFY] `public/css/chat.css`

채팅 헤더에 미세한 drop shadow:
```css
.chat-header {
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    position: relative;
    z-index: 1;
}
```

입력 영역 상단 그림자:
```css
.chat-input-area {
    box-shadow: 0 -1px 3px rgba(0,0,0,0.15);
    position: relative;
    z-index: 1;
}
```

---

### 3. 메시지 등장 애니메이션

#### [MODIFY] `public/css/chat.css`

```css
.msg {
    animation: msgSlideIn 0.2s ease-out;
}

@keyframes msgSlideIn {
    from {
        opacity: 0;
        transform: translateY(8px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
```

> 기존 `addMessage()` JS는 `div.className = 'msg msg-...'`로 DOM 추가 → 자동으로 애니메이션 트리거. **JS 변경 불필요.**

---

### 4. 커스텀 스크롤바

#### [MODIFY] `public/css/variables.css`

```css
/* 얇은 커스텀 스크롤바 — 다크 UI와 통합 */
::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}
::-webkit-scrollbar-track {
    background: transparent;
}
::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
    background: var(--text-dim);
}

/* Firefox */
* {
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
}
```

---

### 5. hover 마이크로인터랙션

#### [MODIFY] `public/css/layout.css`

```css
.btn-clear {
    transition: border-color 0.15s, color 0.15s, transform 0.1s;
}
.btn-clear:hover {
    transform: translateY(-1px);
}
.btn-clear:active {
    transform: translateY(0);
}

.tab-btn {
    transition: color 0.15s, border-bottom-color 0.15s;
}

.sidebar-hb-btn {
    transition: border-color 0.15s, box-shadow 0.15s;
}
.sidebar-hb-btn:hover {
    box-shadow: 0 0 0 1px var(--accent);
}
```

#### [MODIFY] `public/css/chat.css`

Send 버튼:
```css
.btn-send {
    transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
}
.btn-send:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(255,107,107,0.3);
}
.btn-send:active {
    transform: translateY(0);
}
```

#### [MODIFY] `public/css/sidebar.css`

스킬 카드:
```css
.skill-card {
    transition: border-color 0.2s, transform 0.15s, box-shadow 0.15s;
}
.skill-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
}
```

Settings 그룹:
```css
.settings-group {
    transition: border-color 0.2s;
}
.settings-group:hover {
    border-color: color-mix(in srgb, var(--border) 60%, var(--accent));
}
```

---

### 6. 상태 배지 개선

#### [MODIFY] `public/css/layout.css`

```css
.status-badge {
    transition: background 0.3s, color 0.3s;
    letter-spacing: 0.5px;
}

.status-idle {
    box-shadow: 0 0 6px rgba(74,222,128,0.2);
}

.status-running {
    box-shadow: 0 0 6px rgba(251,191,36,0.3);
}
```

---

### 7. 채팅 버블 리파인

#### [MODIFY] `public/css/chat.css`

유저·에이전트 메시지 미세 차별화:
```css
.msg-user {
    border-radius: 12px 12px 4px 12px;   /* 우하단만 날카롭게 */
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}

.msg-agent {
    border-radius: 12px 12px 12px 4px;   /* 좌하단만 날카롭게 */
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
```

---

### 8. 입력 포커스 링 개선

#### [MODIFY] `public/css/chat.css`

```css
.chat-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
}
```

---

## 수정 대상 파일 요약

| 파일 | 변경 내용 |
|------|----------|
| `public/index.html` | Google Fonts `<link>` 추가 (Outfit) |
| `public/css/variables.css` | `--font-ui`, `--font-mono` 추가 + 커스텀 스크롤바 |
| `public/css/layout.css` | 사이드바 깊이감, 버튼 transition, 배지 개선 |
| `public/css/chat.css` | 메시지 애니메이션, 버블 리디자인, 입력 포커스, send 버튼 |
| `public/css/sidebar.css` | 스킬카드·설정그룹 hover, transition |
| `public/css/markdown.css` | 코드 font-family 변수화 |

> **JS 변경: 0건** — 모든 개선이 CSS 전용
> **HTML 변경: Google Fonts `<link>` 1줄만**

---

## 난이도

| 항목 | 난이도 |
|------|--------|
| **종합** | **★★☆☆☆ (하)** |
| 예상 시간 | **1~1.5시간** |
| 위험도 | **매우 낮음** (CSS 전용, JS/HTML 구조 불변) |

---

## Phase 6과의 관계

Phase 5.9에서 추가한 `transition`, `box-shadow`, 커스텀 스크롤바 등은 **CSS 변수를 사용하므로** Phase 6의 테마 전환 시 자동으로 라이트/다크에 맞게 동작함. 순서:

```
Phase 5.9 (비주얼 폴리시) → Phase 6 (테마 + 사이드바 접기) → Phase 7 (i18n)
```
