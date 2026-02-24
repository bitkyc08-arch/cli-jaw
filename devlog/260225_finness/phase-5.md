# Phase 5 (finness): Web UI 마크다운 렌더링 개선

> 현재 render.js 21L — 코드블록, 인라인코드, 볼드, 헤딩만 지원

---

## 현재 미지원 요소

| 요소 | 현재 | 예시 |
|------|:---:|------|
| **테이블** | ❌ | `| col | col |` → raw 텍스트 |
| **리스트** (ul/ol) | ❌ | `- item` → `<br>- item` |
| **링크** | ❌ | `[text](url)` → raw |
| **이탈릭** | ❌ | `*text*` → raw |
| **수평선** | ❌ | `---` → raw |
| **인용** | ❌ | `> quote` → raw |

---

## 접근 방법

### 옵션 A: 직접 regex 파서 확장 (현재 방식)
- 장점: 의존성 0, 번들 크기 0
- 단점: 테이블 파싱이 복잡 (정렬, colspan 등)
- 판정: 테이블은 regex로 하기 어렵

### 옵션 B: marked.js CDN (추천) ✅
- `<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js">` (~35KB gzip)
- GFM 테이블, 리스트, 링크, 인용 등 완벽 지원
- XSS 방지: `marked.setOptions({ sanitize: true })` + DOMPurify
- 코드 하이라이팅: highlight.js 추가 가능

### 옵션 C: markdown-it CDN
- marked보다 약간 무거움 (45KB)
- 플러그인 시스템이 강력
- 대부분의 경우 marked로 충분

---

## 구현 계획 (옵션 B)

### [MODIFY] `public/index.html` — CDN 추가

```html
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
```

### [MODIFY] `public/js/render.js` — marked 기반 렌더링

```js
export function renderMarkdown(text) {
    // Strip orchestration JSON
    let cleaned = text.replace(/```json\n[\s\S]*?\n```/g, '');
    cleaned = cleaned.replace(/\{[\s\S]*"subtasks"\s*:\s*\[[\s\S]*?\]\s*\}/g, '').trim();
    if (!cleaned) return '<em style="color:var(--text-dim)">🎯 작업 분배 중...</em>';
    
    if (typeof marked !== 'undefined') {
        return marked.parse(cleaned);
    }
    // fallback (CDN 실패 시 기존 regex)
    return escapeHtml(cleaned)
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        // ... 기존 코드
}
```

### [NEW] `public/css/markdown.css` — 테이블/코드 스타일

```css
.msg-body table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
.msg-body th, .msg-body td { border: 1px solid var(--border); padding: 4px 8px; }
.msg-body th { background: var(--surface); font-weight: 600; }
.msg-body blockquote { border-left: 3px solid var(--border); margin: 8px 0; padding: 4px 12px; color: var(--text-dim); }
.msg-body ul, .msg-body ol { margin: 4px 0; padding-left: 20px; }
.msg-body pre { background: var(--surface); padding: 8px; border-radius: 6px; overflow-x: auto; }
.msg-body a { color: #60a5fa; text-decoration: none; }
.msg-body hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
```

---

## 검증

1. Copilot (오푸스) + 테이블 포함 응답 요청
2. Web UI에서 테이블 정상 렌더링 확인
3. 코드블록 하이라이팅 확인
4. XSS 벡터 테스트 (`<script>alert(1)</script>`)
