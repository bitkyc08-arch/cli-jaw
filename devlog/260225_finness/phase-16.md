# Phase 16 — 오케스트레이션 done 응답 누락 + 코드블럭 하이라이팅 + 토큰 낭비

> Bug 1: ✅ 완료 (ws.js +2L, ui.js +6L) · Bug 2: ✅ 완료 (CDN 404 수정) · Bug 2.1: 🔴 유저 마크다운 미렌더링 · Bug 3: 🔜 추후 논의

> 주니 보고: "phase 들어가기전에만 응답이 오고, done에서 응답이 안와"
> 추가: 코드블럭 색깔 없음, 복사 버튼 없음, 오케스트레이션 토큰 낭비
> 추가: 유저 메시지 마크다운 렌더링 안 됨

---

## Bug 1: `orchestrate_done` 응답이 UI에 안 나옴 🔴

### 원인

`ws.js`에 **`orchestrate_done` 이벤트 핸들러가 없음**.

```js
// ws.js — 현재 핸들러 목록
agent_status    → setStatus()
queue_update    → updateQueueBadge()
worklog_created → addSystemMsg()
round_start     → addSystemMsg()
round_done      → addSystemMsg()
agent_tool      → addSystemMsg()
agent_output    → appendAgentText()
agent_done      → finalizeAgent()  ← 유일한 텍스트 렌더링 경로
// ❌ orchestrate_done → ??? (handled nowhere!)
```

`orchestrator.js`에서 `orchestrate_done`은 **8곳**에서 broadcast:
- L472: triage direct → `{ text }` 
- L481: no employees → `{ text }`
- L495: planning direct_answer → `{ text }`
- L500: no subtasks → `{ text }`
- L536: round loop allDone → `{ text, worklog }`
- L552: max round partial → `{ text, worklog }`
- L563/569: continue 경로 → `{ text }`

**문제**: 일부 경로에서만 `agent_done`도 함께 broadcast (L494). L536/L552 (미니멀 오케스트레이션 완료) 경로에서는 `orchestrate_done`만 broadcast → UI 무반응.

### 수정 방안

**Option A**: `ws.js`에 `orchestrate_done` 핸들러 추가 → `finalizeAgent(msg.text)` 호출

```js
// ws.js — 추가
} else if (msg.type === 'orchestrate_done') {
    finalizeAgent(msg.text);
}
```

**Option B**: `orchestrator.js`에서 `orchestrate_done` 전에 항상 `agent_done` broadcast

→ **Option A 추천** (프론트 1줄 수정, 백엔드 무변경)

> [!CAUTION]
> `agent_done`과 `orchestrate_done`이 **동시에** 오는 경로(L494-495)에서 이중 렌더링 방지 필요.
> → `finalizeAgent()`에 guard 추가: 이미 finalize된 상태면 무시.

---

## Bug 2: 코드블럭 syntax highlighting 안 나옴 🟡

### 현재 구조

```text
index.html:  <script defer src="hljs@11/highlight.min.js" onload="...rehighlightAll()">
render.js:   renderer.code = function({ text, lang }) { if (typeof hljs !== 'undefined') ... }
             rehighlightAll() → document.querySelectorAll('.code-block-wrapper pre code')
```

### 근본 원인 ✅ 확정

**jsdelivr CDN에서 `highlight.js@11` 패키지가 404 반환.**

```bash
$ curl -sI "https://cdn.jsdelivr.net/npm/highlight.js@11/highlight.min.js"
HTTP/2 404
```

jsdelivr에서 `highlight.js` 패키지의 major-only 버전 태그(`@11`)가 resolve 안 됨.
→ `<script defer>` 로드 실패 → `typeof hljs === 'undefined'` → `escapeHtml()` 폴백 → 흰색 단색 출력.

같은 CDN의 `marked@14`, `katex@0.16`, `dompurify@3`은 정상 resolve → hljs만 단독 실패.

### 수정 내역 ✅ 완료

**1) CDN 교체 (jsdelivr → cdnjs.cloudflare.com)**

| 파일 | 변경 |
|------|------|
| `index.html` L20-24 | hljs CSS + JS URL을 `cdnjs.cloudflare.com/.../11.11.1/...`로 변경 |
| `theme.js` L6-7 | `HLJS_DARK`, `HLJS_LIGHT` URL도 동일하게 변경 |

```bash
$ curl -sI "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"
HTTP/2 200  # ✅
```

**2) rehighlightAll() 개선 (render.js)**

- `hljs.highlightElement()` 대신 `hljs.highlight()` 수동 호출 (innerHTML 직접 교체, 더 안정적)
- `data-highlighted === 'yes'` 플래그로 중복 방지
- `language-*` 클래스에서 언어 추출 → 해당 언어로 하이라이팅, 없으면 `highlightAuto`

**3) hljs 로드 자동 감지 (render.js)**

- 200ms 폴링으로 `typeof hljs !== 'undefined'` 감지 → `rehighlightAll()` 자동 호출
- `index.html`의 `onload` 속성 제거 (폴링으로 대체)

**4) renderMarkdown() 내 재하이라이팅 (render.js)**

- `requestAnimationFrame` 내에서 `renderMermaidBlocks()` + `rehighlightAll()` 동시 호출
- 새 메시지 렌더링 시에도 DOM 삽입 직후 하이라이팅 보장

### 디버깅 과정

```
1. 브라우저 콘솔 확인: typeof hljs → "undefined" (모든 CDN 라이브러리 미로드)
2. 페이지 이동 후 재확인: marked=object, DOMPurify=function, hljs=undefined
3. curl -sI jsdelivr URL → HTTP/2 404 확인 ← 근본 원인
4. cdnjs URL 테스트 → HTTP/2 200 확인
5. CDN 교체 후 reload: typeof hljs → "object", version "11.11.1"
6. rehighlightAll() 수동 실행 → 13개 블럭 전부 highlighted
7. hljs-keyword span의 computedColor → rgb(255,123,114) 확인 (정상)
```

### 복사 버튼 현황

**이미 구현됨** ✅ (`render.js` L147-170, `markdown.css` L140-162):
- `.code-lang-label` 클릭 → `navigator.clipboard.writeText` → "복사됨 ✓" 피드백
- CSS: `cursor: pointer`, hover scale, `.copied` 색상 변경
- 언어 없는 코드블럭은 `labelText = '복사'`로 표시

→ **hljs CDN 404가 근본 원인이었으므로 CDN 교체로 모두 해결됨** ✅

---

## Bug 2.1: 유저 메시지 마크다운 렌더링 안 됨 🔴

### 원인

`ui.js` L95에서 유저 메시지는 `escapeHtml()`로만 처리:

```js
const rendered = role === 'agent' ? renderMarkdown(text) : escapeHtml(text);
```

agent 메시지만 `renderMarkdown()`을 거치고, 유저 메시지는 마크다운 문법이 그대로 텍스트로 출력됨.
코드블럭, 볼드, 링크 등이 전부 raw 텍스트로 보임.

### 수정 방안

`escapeHtml(text)` → `renderMarkdown(text)`로 변경. 유저 메시지에도 동일한 마크다운 파이프라인 적용.

```diff
- const rendered = role === 'agent' ? renderMarkdown(text) : escapeHtml(text);
+ const rendered = renderMarkdown(text);
```

단, XSS 안전성은 `renderMarkdown()` 내부의 `sanitizeHtml(DOMPurify)`가 이미 처리하므로 추가 조치 불필요.

### 영향 파일

- `public/js/ui.js` L95 — 1줄 수정

### 상태: ✅ 완료

---

## Bug 3: 오케스트레이션 토큰 낭비 🟠

### 원인 분석

| 낭비 지점 | 코드 위치 | 영향 |
|-----------|----------|------|
| 매 spawn마다 `getSystemPrompt()` 풀 재생성 | `agent.js:226` | 스킬 레지스트리 + MEMORY + 직원 매회 재조립 |
| sub-agent에 풀 프롬프트 이중 주입 | Claude `--append-system-prompt` + AGENTS.md 이중 | 토큰 2배 |
| phase마다 스킬 파일 disk I/O | `prompt.js:430-455` `readFileSync` | 3 agents × 5 phases = 15회 |
| review에서 결과 재전송 | `orchestrator.js:401-403` 400자×N + matrix | 매 라운드 반복 |

**최악**: 3 agents × 5 phases × 3 rounds + 3 plan + 3 review = **51회** spawn.

### 수정 방안

1. **sub-agent prompt 캐싱**: 같은 role 에이전트는 orchestrate() 내에서 1회 생성 후 재사용
2. **스킬 파일 메모리 캐싱**: `getSubAgentPromptV2()`에서 `readFileSync` → 캐시 (orchestration 단위)
3. **`agent.js` 빈 문자열 sysPrompt 처리**: `customSysPrompt || getSystemPrompt()` → `customSysPrompt != null ? customSysPrompt : getSystemPrompt()`
4. **review 결과 압축**: 200자 + 완료 에이전트 생략

---

## 구현 계획

| # | 작업 | 파일 | 상태 |
|---|------|------|------|
| 1 | `orchestrate_done` 핸들러 추가 | `ws.js` | ✅ 완료 |
| 2 | `finalizeAgent()` 이중 호출 guard | `ui.js` | ✅ 완료 |
| 3 | hljs CDN 404 수정 (jsdelivr→cdnjs) | `index.html`, `theme.js` | ✅ 완료 |
| 4 | `rehighlightAll()` 개선 + 폴링 | `render.js` | ✅ 완료 |
| 5 | 복사 버튼 (이벤트 위임) | `render.js`, `markdown.css` | ✅ 완료 |
| 5.1 | 유저 메시지 마크다운 렌더링 | `ui.js` | ✅ 완료 |
| 6 | sub-agent prompt 캐싱 | `orchestrator.js` | 🔜 P2 |
| 7 | 스킬 파일 캐싱 | `prompt.js` | 🔜 P2 |
| 8 | sysPrompt null 체크 수정 | `agent.js` | 🔜 P2 |
| 9 | review 결과 압축 | `orchestrator.js` | 🔜 P2 |

### 우선순위

**P0 (즉시)**: #1, #2 — done 응답이 안 나오는 건 사용자 경험 치명적 ✅
**P1 (같은 날)**: #3, #4, #5 — CDN 404 수정 + 하이라이팅 + 복사 버튼 ✅
**P2 (다음)**: #6~#9 — 토큰 비용 최적화

---

## 검증

```bash
# 기존 테스트 회귀 확인
cd /Users/junny/Documents/BlogProject/cli-claw && npm test

# P0 수동 검증
# 1. 서버 기동 → 오케스트레이션 필요한 메시지 전송 → UI에 완료 응답 나오는지 확인
# 2. 코드블럭 포함 메시지 전송 → 색깔 나오는지 확인
# 3. 언어 라벨 클릭 → 복사되는지 확인
```
