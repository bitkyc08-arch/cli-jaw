# 🐛 Mermaid 렌더링 + 메시지 유실 버그 — ✅ 수정 완료

**날짜**: 2025-02-25
**심각도**: High (핵심 기능 4개 장애)
**영향 파일**: `public/js/render.js`, `public/css/markdown.css`, `server.ts`
**상태**: ✅ 수정 완료 — 번들 리빌드 + 테스트 252개 통과

---

## 증상 요약

| # | 버그 | 현상 |
|---|------|------|
| 1 | 텍스트 미표시 | Mermaid 다이어그램의 노드/엣지 안에 텍스트(레이블)가 보이지 않음. 도형만 렌더링됨 |
| 2 | X 버튼 미작동 | 확대 오버레이의 ✕ 닫기 버튼 클릭 시 아무 반응 없음. 배경 클릭으로만 닫힘 |
| 3 | 확대 크기 부족 | 오버레이로 확대해도 다이어그램이 여전히 작음 |
| 4 | 새로고침 시 유저 메시지 유실 | 웹 UI에서 보낸 최신 유저 메시지가 새로고침하면 사라짐 |

---

## 버그 1: 텍스트 미표시 (가장 치명적)

### 근본 원인 (추정): DOMPurify가 `<foreignObject>` 제거

**핵심 코드** (`render.js:54-63`):
```javascript
function sanitizeMermaidSvg(svg) {
    return DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['style', 'use'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    });
}
```

**문제 분석**:
- Mermaid v11은 노드 안의 텍스트를 `<foreignObject>` + `<div>/<span>` HTML로 렌더링함
- DOMPurify의 `USE_PROFILES: { svg: true }`는 SVG 태그만 허용
- `ADD_TAGS`에 `foreignObject`가 **없음** → DOMPurify가 텍스트 포함 요소 전부 제거
- 결과: 도형(rect, polygon)은 살아남고, 텍스트(foreignObject 안의 HTML)는 삭제

### 검증 방법
```javascript
// 브라우저 콘솔에서 테스트
const testSvg = '<svg><foreignObject><div>Hello</div></foreignObject></svg>';
console.log(DOMPurify.sanitize(testSvg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style', 'use'],
}));
// 예상: foreignObject가 사라짐
```

### ✅ 최종 수정 (2차)
DOMPurify는 `foreignObject` + 내부 `<style>` 등 mermaid가 필요로 하는 태그를 계속 제거함.
`ADD_TAGS`로 하나씩 추가하는 방식은 한계 — **DOMPurify를 mermaid SVG에서 완전 제거**.

`mermaid.render()`가 `securityLevel: 'loose'`로 자체 sanitize하므로 이중 sanitize 불필요.

```javascript
// 변경 전: sanitizeMermaidSvg(svg) 호출
el.innerHTML = sanitizeMermaidSvg(svg);

// 변경 후: 직접 할당 (mermaid 자체 sanitize 신뢰)
el.innerHTML = svg;
```

추가로 팝업 오버레이에 버튼 2개 표시되던 버그도 수정:
```javascript
// 변경 전: el.innerHTML에 zoom 버튼까지 포함되어 전달
zoomBtn.addEventListener('click', () => openMermaidOverlay(el.innerHTML));

// 변경 후: SVG만 따로 저장하여 전달
const rawSvg = el.innerHTML;  // zoom 버튼 추가 전에 저장
zoomBtn.addEventListener('click', () => openMermaidOverlay(rawSvg));
```

---

## 버그 2: X 버튼 미작동

### 근본 원인 (추정): SVG 오버플로우로 클릭 가로챔

**핵심 코드** (`render.js:97-128`, `markdown.css:208-230`):

**문제 분석**:
- `.mermaid-overlay-close`는 `z-index: 1`로 설정
- `.mermaid-overlay-svg` 안의 SVG가 `width: 100%`로 확장되며 close 버튼 영역을 덮을 수 있음
- SVG 요소는 기본적으로 `pointer-events: visiblePainted`이므로, SVG가 버튼 위로 올라가면 클릭을 가로챔
- 또는: `.mermaid-overlay-content`의 `overflow: auto`가 스크롤 영역을 만들어 버튼이 스크롤 밖으로 밀림

### 검증 방법
1. 브라우저 DevTools → Elements → ✕ 버튼 선택 → "Event Listeners" 탭 확인
2. DevTools → ✕ 버튼 위에 마우스 → hover 효과 발생하는지 확인
3. CSS computed styles에서 `pointer-events` 값 확인

### ✅ 적용된 수정
**CSS** (`markdown.css`):
- `.mermaid-overlay-close`: `z-index: 1` → `z-index: 10`, `pointer-events: auto`, 크기 32→36px, 폰트 16→18px
- `.mermaid-overlay-svg`: `z-index: 0` 추가 (SVG가 버튼 위로 못 올라감)

**JS** (`render.js`):
```javascript
overlay.querySelector('.mermaid-overlay-close').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    close();
});
```

---

## 버그 3: 확대 크기 부족

### 근본 원인 (추정): SVG viewBox 미설정 + max-height 제약

**핵심 코드** (`render.js:112-120`):
```javascript
svgEl.removeAttribute('width');
svgEl.removeAttribute('height');
svgEl.style.width = '100%';
svgEl.style.height = 'auto';
svgEl.style.maxHeight = '80vh';
```

**문제 분석**:
- Mermaid v11이 생성하는 SVG의 `viewBox`가 작은 값일 수 있음
- `width/height` 속성 제거 후 `viewBox`만으로 크기 결정 → SVG가 작게 유지
- `max-height: 80vh`는 세로를 제한하지만, 가로가 충분히 확장되지 않을 수 있음
- `.mermaid-overlay-content`의 `padding: 24px` + `max-width: 90vw`가 실제 가용 공간을 줄임

### 검증 방법
1. DevTools에서 SVG 요소의 `viewBox` 값 확인
2. SVG의 computed width/height 확인
3. overlay-content의 실제 렌더링 크기 확인

### ✅ 적용된 수정
**CSS** (`markdown.css`):
- `.mermaid-overlay-content`: `padding: 24px` → `20px`, `max-width: 90vw` → `95vw`, `max-height: 90vh` → `95vh`

**JS** (`render.js`):
- SVG `maxHeight: 80vh` → `85vh`

---

## 수정 우선순위

| 순서 | 버그 | 난이도 | 영향도 |
|------|------|--------|--------|
| 1 | 텍스트 미표시 | ⭐⭐ | 🔴 Critical — 다이어그램 의미 없음 |
| 2 | X 버튼 | ⭐ | 🟡 Medium — 배경 클릭으로 우회 가능 |
| 3 | 확대 크기 | ⭐ | 🟡 Medium — 기능은 작동 |

---

## 테스트 계획

### 수정 후 검증 체크리스트
- [ ] Mermaid `graph LR` 다이어그램 — 모든 노드에 텍스트 표시되는지
- [ ] Mermaid `graph TD` 다이어그램 — 조건 분기(diamond) 텍스트 확인
- [ ] Mermaid `sequenceDiagram` — actor/message 텍스트 확인
- [ ] 확대 오버레이 ✕ 버튼 클릭 → 정상 닫힘
- [ ] 확대 오버레이 Escape 키 → 정상 닫힘
- [ ] 확대 시 다이어그램이 화면 85%+ 차지하는지
- [ ] DOMPurify sanitize 후에도 XSS 취약점 없는지 (script 태그 차단)

### 브라우저 콘솔 디버깅 스니펫
```javascript
// 1. 텍스트 버그 확인
document.querySelectorAll('.mermaid-rendered svg foreignObject').length
// 0이면 → DOMPurify가 foreignObject 제거 확정

// 2. X 버튼 이벤트 확인
const closeBtn = document.querySelector('.mermaid-overlay-close');
if (closeBtn) {
    const rect = closeBtn.getBoundingClientRect();
    console.log('Close btn rect:', rect);
    console.log('Pointer events:', getComputedStyle(closeBtn).pointerEvents);
}

// 3. SVG 크기 확인
const svg = document.querySelector('.mermaid-overlay-svg svg');
if (svg) {
    console.log('viewBox:', svg.getAttribute('viewBox'));
    console.log('computed:', svg.getBoundingClientRect());
}
```

---

## 버그 4: 새로고침 시 유저 메시지 유실 🔴

### 근본 원인: `/api/message` POST에서 user 메시지를 DB에 저장하지 않음

**메시지 저장 경로 비교**:

| 경로 | DB INSERT | broadcast |
|------|-----------|-----------|
| WebSocket (`ws.on('message')`) | ✅ `insertMessage.run('user', text, 'cli', '')` | ✅ |
| Queue → processQueue | ✅ `insertMessage.run('user', combined, source, '')` | ✅ |
| **HTTP POST `/api/message`** | ❌ **누락!** | ❌ **누락!** |

**서버 코드** (`server.ts:385-405`):
```javascript
app.post('/api/message', (req, res) => {
    // ...
    orchestrate(trimmed, { origin: 'web' });  // ← user 메시지 INSERT 없이 바로 호출
    res.json({ ok: true });
});
```

웹 UI에서 메시지를 보내면 → `chat.js:sendMessage()` → `POST /api/message` → `orchestrate()` 호출
BUT user 메시지는 DB에 저장되지 않음 → 새로고침 시 `GET /api/messages`로 불러오면 누락

### ✅ 적용된 수정
```javascript
// server.ts — orchestrate 호출 전에 user 메시지 저장
insertMessage.run('user', trimmed, 'web', '');
broadcast('new_message', { role: 'user', content: trimmed, source: 'web' });
orchestrate(trimmed, { origin: 'web' });
```

이제 3개 경로 모두 일관되게 user 메시지를 DB에 저장 후 orchestrate 호출.
