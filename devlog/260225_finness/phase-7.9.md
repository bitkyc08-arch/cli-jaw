# Phase 7.9 (finness): 안정화 보강 — 상세 실행 계획

> 작성일: 2026-02-25  
> 상태: `done`  
> 기준: 최신 작업 트리 + 코드 실사

---

## 0) 현재 상태 스냅샷

```bash
npm test
# tests 78
# pass 78
# fail 0
```

- `Refresh` 클릭 시 채팅 삭제되는 회귀 → 이미 수정됨
- 문서/스타일/UI 리팩터 변경이 집중된 커밋 히스토리

---

## 1) 코드 실사 결과

### P0: Markdown 렌더링 XSS — 확인됨

**DOMPurify 미적용 상태.**  프로젝트 전체에서 DOMPurify import/CDN 없음.

#### 공격면 상세

| 위치 | 파일:라인 | 위험 |
|------|----------|------|
| `marked.parse()` → 반환 | `render.js:L127` | sanitize 없이 반환 |
| `finalizeAgent()` → `innerHTML` | `ui.js:L76` | `renderMarkdown(text)` 결과 직접 주입 |
| `addMessage()` → `innerHTML` | `ui.js:L88` | agent 응답 렌더링 경로 |
| `loadMemory()` → `innerHTML` | `ui.js:L139` | 서버 데이터 주입 |
| Mermaid SVG → `innerHTML` | `render.js:L45` | `el.innerHTML = svg` |
| Mermaid 에러 → `innerHTML` | `render.js:L49` | 에러 메시지 주입 |
| Mermaid `securityLevel` | `render.js:L97` | `'loose'` → 스크립트 허용 |

#### 기타 `innerHTML` 사용 (33곳+)

- `settings.js`: 12곳  
- `employees.js`: 3곳  
- `slash-commands.js`: 3곳  
- `heartbeat.js`: 2곳, `memory.js`: 3곳, `skills.js`: 2곳  
- `chat.js`: 2곳, `ws.js`: 1곳

> ⚠️ **최고 위험 경로**: 에이전트 CLI 응답 → `marked.parse()` → `innerHTML`. AI CLI가 악의적/오염 응답을 반환하면 스크립트 주입 가능.

#### CDN 현황 (index.html L19-26)

```html
<!-- 현재 로드 중 -->
<script defer src="https://cdn.jsdelivr.net/npm/marked@14/marked.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/highlight.js@11/highlight.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<!-- ❌ DOMPurify 없음 -->
```

---

### P1: Copilot 인증 안내 — 불일치 확인됨

| 위치 | 현재 안내 | 파일:라인 |
|------|----------|-----------|
| 런타임 에러 | `gh auth login` | `src/agent.js:391` |
| postinstall 경고 | `gh auth login` | `bin/postinstall.js:120` |
| UI 인증 가이드 | `copilot login` | `public/js/features/settings.js:436` |
| README.md | `copilot login` | `README.md:137` |
| README.ko.md | `copilot login` | `README.ko.md:134` |
| README.zh-CN.md | `copilot login` | `README.zh-CN.md:134` |

→ 사용자 입장에서 Copilot 인증 실패 시 어떤 명령을 먼저 써야 하는지 혼선.

---

### P2: 문서 정합성 — 검증 기록 없음

- Phase 문서 25개 중 검증 결과(`npm test` + 변경 파일) 첨부된 문서 **0개**
- "완료" 표기와 실제 코드 상태 동기화 기준 모호
- 코드 변경 포함 커밋에 `docs:` prefix 혼용

---

## 2) Phase 7.9 목표

1. Web UI 렌더링 경로의 **스크립트 주입면 차단**
2. Copilot 인증/설치 가이드를 **단일 기준으로 통일**
3. 문서와 코드 상태를 **검증 가능한 체크리스트**로 동기화

---

## 3) 작업 계획

### 3-1. P0: Markdown 렌더링 보안 하드닝

#### 대상 파일

- `public/index.html` — CDN 추가
- `public/js/render.js` — sanitize 함수 + 적용
- `tests/unit/render-sanitize.test.js` — [NEW]

#### 의존성 체인

```
Step 1: DOMPurify CDN 추가 (index.html)
  └→ Step 2: sanitizeHtml() 구현 (render.js)
      ├→ Step 3: Mermaid securityLevel → strict (render.js)
      ├→ Step 4: Mermaid SVG 결과 sanitize (render.js)
      └→ Step 5: 테스트 작성 (tests/unit/)
```

#### Step 1: DOMPurify CDN 추가

```html
<!-- index.html: mermaid CDN 다음에 추가 -->
<script defer src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
```

#### Step 2: `sanitizeHtml()` 함수 구현

```js
// render.js — 새 함수
export function sanitizeHtml(html) {
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
      ADD_TAGS: ['use'],  // Mermaid SVG 호환
    });
  }
  // CDN 실패 시 regex fallback
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=/gi, 'data-removed=')
    .replace(/javascript\s*:/gi, 'about:blank');
}
```

#### Step 3: renderMarkdown()에 적용

```diff
 export function renderMarkdown(text) {
     ...
     html = renderMath(html);
+    html = sanitizeHtml(html);
     requestAnimationFrame(renderMermaidBlocks);
     return html;
 }
```

#### Step 4: Mermaid 설정 강화

```diff
 window.mermaid.initialize({
     startOnLoad: false,
     theme: 'dark',
-    securityLevel: 'loose',
+    securityLevel: 'strict',
 });
```

#### Step 5: Mermaid SVG 결과도 sanitize

```diff
 // renderMermaidBlocks() 내부
 const { svg } = await mermaid.render(id, code);
-el.innerHTML = svg;
+el.innerHTML = sanitizeHtml(svg);
```

#### 리스크 + 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| DOMPurify CDN 로드 실패 | sanitize 미작동 | regex fallback 포함 |
| Mermaid `strict` 렌더링 깨짐 | 다이어그램 미표시 | `sandbox`로 단계적 변경 |
| DOMPurify가 KaTeX 출력 파괴 | 수식 깨짐 | `ADD_TAGS` 커스텀 |
| 서버사이드 unit test 한계 | 브라우저 API 의존 | regex fallback만 unit test |

#### 완료 기준

- [x] `javascript:` 링크, inline event, `<script>` → 렌더 결과에 남지 않음
- [x] 기존 코드블록/테이블/KaTeX/Mermaid 정상 동작 유지
- [x] `npm test` 전체 통과 + 신규 sanitize 테스트 통과

---

### 3-2. P1: Copilot 인증 안내 단일화

#### 대상 파일 (6개)

- `src/agent.js:391`
- `bin/postinstall.js:120`
- `public/js/features/settings.js:436`
- `README.md:137`
- `README.ko.md:134`
- `README.zh-CN.md:134`

#### 의존성 체인

```
Step 1: 통일 정책 결정
  ├→ Step 2: agent.js 에러 메시지 수정
  ├→ Step 3: postinstall.js 경고 수정
  ├→ Step 4: settings.js UI 가이드 수정
  └→ Step 5: README x3 동기화  (독립)
```

#### 통일 메시지 정책

```text
1차: gh auth login          (GitHub CLI 인증)
2차: gh copilot --help       (확장 설치 확인)
3차: copilot login            (standalone 사용 시)
```

#### 완료 기준

- [ ] 6개 파일 모두 동일 순서/명령으로 안내
- [ ] Copilot 인증 실패 시 재현 절차가 문서와 일치

---

### 3-3. P2: 문서-코드 정합성 체크

#### 대상

- `devlog/260225_finness/phase-*.md` (25개)
- `devlog/str_func.md`

#### 작업

1. 각 phase 문서에 검증 결과 고정 섹션 추가 (template)
2. "완료" 표기 시 필수 체크 3개 강제
3. 코드 변경 포함 커밋에서 `docs:` prefix 사용 제한 가이드

#### 체크리스트 템플릿 (완료 전 필수)

```markdown
## 검증 결과
- [ ] `npm test` 결과 (pass/fail)
- [ ] 변경 파일 목록 (`git log --name-only`)
- [ ] known risk / deferred items
```

#### 완료 기준

- [ ] 향후 phase 문서 완료 시 검증 결과 섹션 필수 포함
- [ ] 기존 완료 문서에 최종 상태 백필

---

## 4) Phase 간 의존성

### Phase 7.9 vs Phase 8/9 관계

| 관계 | 설명 |
|------|------|
| Phase 8.1 (서버 입력 검증) | **충돌 없음** — 8.1은 서버측, 7.9 P0은 클라이언트측 |
| Phase 9 (백엔드 보안) | **병행 가능** — 7.9 P0 선처리 시 프론트 보안 부채 감소 |
| Phase 8.3 (server.js 모듈화) | **무관** — 7.9는 프론트엔드만 수정 |

### P0 → P1 → P2 순서 근거

1. P0이 보안 이슈 → 최우선
2. P1은 P0과 무관하지만 사용자 혼선 방지 → 차순위
3. P2는 코드 변경 없음 → 마지막

---

## 5) 실행 순서

1. **P0**: DOMPurify CDN → sanitizeHtml → Mermaid strict → 테스트
2. **P1**: 인증 문구 6개 파일 통일
3. **P2**: 문서 정합성 체크리스트 추가

---

## 6) 검증 명령

```bash
npm test
npm run test:events
npm run test:telegram
node --test tests/unit/render-sanitize.test.js
git log -10 --name-only --oneline
```

---

## 7) 예상 산출물

1. `phase-7.9.md` (본 문서)
2. 렌더링 sanitize 반영 커밋 1건 (DOMPurify + sanitizeHtml + Mermaid strict + 테스트)
3. 인증 문구 통일 커밋 1건
4. 문서 정합성/체크리스트 반영 커밋 1건
