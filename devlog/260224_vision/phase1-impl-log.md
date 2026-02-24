---
created: 2026-02-24
tags: [vision-click, phase1, 구현로그]
status: done
commits: [5e17fac, 90c2142]
---

# (fin) Vision Click Phase 1 — 상세 구현 로그

> Codex-only 비전 좌표 클릭. 2026-02-24 구현.

---

## 1. 배경 및 문제 정의

### 문제
`cli-claw browser snapshot` → `click <ref>` 패턴은 DOM 기반이라, 다음 요소에서 ref가 안 잡힘:
- **Canvas 요소**: WebGL, 그래픽 렌더링
- **iframe 내부**: 크로스오리진 제약
- **Shadow DOM**: 커스텀 웹 컴포넌트 내부
- **동적 렌더링**: SVG, PDF viewer, 게임 UI

### 해결 방향
**스크린샷 → AI 비전 모델 → 좌표 추출 → 픽셀 클릭**

---

## 2. CLI 스모크 테스트 (사전 검증)

800×600px 테스트 이미지 (LOGIN + SIGNUP 버튼)로 3개 CLI 검증:

### ✅ Codex CLI — `codex exec -i screenshot.png --json`

```bash
codex exec -i /tmp/vision-test-ui.png --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  'Find "LOGIN" button center pixel coordinate. Return JSON: {"found":true,"x":int,"y":int}'
```

결과:
| Target | 실제 좌표  | Codex 응답 | 오차     |
| ------ | ---------- | ---------- | -------- |
| LOGIN  | (400, 275) | (400, 276) | **±1px** |
| SIGNUP | (400, 345) | (400, 345) | **±0px** |

동작 방식: Codex가 PIL(Python Imaging Library)을 자동 사용하여 픽셀 분석. agentic 패턴.

### ❌ Gemini CLI — stdin binary 미지원

```bash
cat /tmp/vision-test-ui.png | gemini -p 'Find button...'
```

null byte 에러 또는 바이너리를 텍스트로 오인. 좌표 ~200px 벗어남.
→ REST API(`@google/generative-ai` SDK) 직접 호출 필요 (Phase 2).

### ❌ Claude Code CLI — `--print` 모드 비전 불가

```bash
claude -p 'Read /tmp/vision-test-ui.png and find...'
```

`--print` 모드에서 이미지 분석 불가. `Read` 도구로 바이너리 파일 접근 실패.
→ Claude REST API (Messages API) 직접 호출 필요 (Phase 2).

---

## 3. 설계 결정

### Q1: browser 스킬에 append vs 별도 스킬?
**→ 별도 `vision-click` 스킬.** Codex-only 전용 기능이 범용 browser 스킬에 섞이면 혼란.

### Q2: 자동 활성화?
**→ Phase 1은 수동 (`cli-claw skill install vision-click`).** 자동 활성화는 스킬 시스템에 `cli_only` 필드 추가 필요 → Phase 2.

### Q3: `mouse-click` 라우트 위치?
**→ 기존 `/api/browser/act` 의 `kind` 확장.** 별도 라우트 아닌 `kind: 'mouse-click'`.
(코드 리뷰에서 수정됨. 원래 계획은 별도 `/api/browser/mouse-click` 라우트였음)

### Q4: A1_CONTENT 수정?
**→ `getSystemPrompt()` 동적 주입.** A-1.md는 최초 1회만 생성되므로 코드 수정이 기존 설치에 반영 안 됨.
(코드 리뷰에서 수정됨)

### Q5: `skill install`에 `skills_ref` fallback?
**→ 추가.** CLI `skill install`이 Codex → GitHub만 시도하고 로컬 `skills_ref/`를 보지 않던 버그 수정.
(코드 리뷰에서 발견)

### Q6: registry.json 기존 사용자 반영?
**→ 라운드 2에서 수정.** `copyDefaultSkills()`에서 `registry.json`은 항상 덮어쓰기로 변경.
(원래 기각했으나 2차 리뷰에서 수용)

---

## 4. 구현 상세 (9개 파일)

### 4.1 `skills_ref/vision-click/SKILL.md` [NEW]

- YAML frontmatter: name, description, requires (bins: codex, cli-claw)
- 워크플로: snapshot → ref 확인 → 없으면 screenshot → codex exec -i → mouse-click
- 파싱 가이드: NDJSON `item.type === 'agent_message'` → JSON `{found, x, y}`
- 정확도 표: ±1px (LOGIN), ±0px (SIGNUP)
- 제한사항: Codex-only, 2-5s latency, ~$0.005-0.01/call, DPR 미처리

### 4.2 `src/browser/actions.js` [MODIFY +8L]

```javascript
export async function mouseClick(port, x, y, opts = {}) {
    const page = await getActivePage(port);
    if (opts.doubleClick) await page.mouse.dblclick(x, y);
    else await page.mouse.click(x, y);
    return { success: true, clicked: { x, y } };
}
```

기존 `click(port, ref, opts)` 패턴과 동일 구조. `page.mouse.click()` 사용.

### 4.3 `src/browser/index.js` [MODIFY +1L]

`mouseClick` re-export 추가.

### 4.4 `server.js` [MODIFY +2L]

`/api/browser/act` 라우트의 destructuring에 `x, y` 추가:
```diff
-const { kind, ref, text, key, submit, doubleClick } = req.body;
+const { kind, ref, text, key, submit, doubleClick, x, y } = req.body;
```

`switch (kind)`에 `case 'mouse-click'` 추가:
```javascript
case 'mouse-click': result = await browser.mouseClick(cdpPort(), x, y, { doubleClick }); break;
```

### 4.5 `bin/commands/browser.js` [MODIFY +13L]

`mouse-click <x> <y> [--double]` 서브커맨드 추가:
```javascript
case 'mouse-click': {
    const x = parseInt(process.argv[4]);
    const y = parseInt(process.argv[5]);
    if (isNaN(x) || isNaN(y)) { /* error */ }
    const opts = {};
    if (process.argv.includes('--double')) opts.doubleClick = true;
    await api('POST', '/act', { kind: 'mouse-click', x, y, ...opts });
    console.log(`🖱️ clicked at (${x}, ${y})`);
}
```

help 텍스트에도 `mouse-click <x> <y>   Click at pixel coordinates [--double] (vision-click)` 추가.

### 4.6 `bin/commands/skill.js` [MODIFY +18L]

`installFromRef(name)` 함수 추가:
```javascript
function installFromRef(name) {
    const REF_DIR = join(CLAW_HOME, 'skills_ref');
    const src = join(REF_DIR, name);
    const dst = join(SKILLS_DIR, name);
    if (existsSync(dst)) return { status: 'exists', path: dst };
    if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) return null;
    cpSync(src, dst, { recursive: true });
    return { status: 'installed', path: dst, source: 'skills_ref' };
}
```

설치 순서: **Codex → Ref → GitHub** (기존: Codex → GitHub)

### 4.7 `src/prompt.js` [MODIFY +13L]

`getSystemPrompt()` 끝에 vision-click 동적 힌트:
```javascript
// Codex CLI 활성 + vision-click 스킬 설치 시에만 주입
const session = getSession();
if (session.active_cli === 'codex') {
    const visionSkillPath = join(SKILLS_DIR, 'vision-click', 'SKILL.md');
    if (fs.existsSync(visionSkillPath)) {
        prompt += '\n### Vision Click (Active)\n';
        prompt += '- If browser snapshot shows no ref for target, use vision-click...\n';
    }
}
```

### 4.8 `skills_ref/registry.json` [MODIFY +16L]

`vision-click` 항목 추가 (browser 뒤):
```json
"vision-click": {
    "name": "Vision Click",
    "emoji": "👁️",
    "category": "automation",
    "description": "비전 기반 좌표 클릭. Codex CLI 전용.",
    "requires": { "bins": ["codex", "cli-claw"], "system": ["Google Chrome"] },
    "canonical_id": "vision-click",
    "aliases": ["vision", "eye-click"],
    "workflow": "vision_coordinate",
    "provider": "openai",
    "status": "active"
}
```

### 4.9 `skills_ref/browser/SKILL.md` [MODIFY +4L]

`## Non-DOM Elements` 섹션 추가:
```markdown
If `snapshot` returns **no ref** for your target (Canvas, iframe, Shadow DOM, etc.),
use the **vision-click** skill (Codex only). See `skills_ref/vision-click/SKILL.md`.
```

---

## 5. 리뷰 라운드 2 패치 (commit `90c2142`)

| 이슈                                 | 수정                                     |
| ------------------------------------ | ---------------------------------------- |
| registry.json 기존 사용자 반영 안 됨 | `mcp-sync.js:414` — 파일은 항상 덮어쓰기 |
| SKILL.md 스크린샷 출력 형식 불일치   | `{ path: ... }` → 경로 문자열            |
| phase1-plan.md 깨진 링크             | `[implementation_plan.md]` 참조 제거     |

---

## 6. 문서 업데이트

### str_func.md (메인)
- actions.js 178L + mouseClick
- browser.js 16개 서브커맨드 + mouse-click
- skill.js + installFromRef
- prompt.js 414L + vision-click 주입
- skills_ref 54개 (+ vision-click)
- devlog 테이블 + 260224_vision

### str_func 서브 문서
- `infra.md`: browser 테이블에 getPageText + mouseClick 추가, mcp-sync copyDefaultSkills 설명 업데이트
- `server_api.md`: 687L, /act +mouse-click, 16 서브커맨드, skill install 경로
- `agent_spawn.md`: prompt.js 414L, getSystemPrompt +vision-click 힌트

### README.md
- Features: + Vision Click
- Browser 섹션: + mouse-click 커맨드 + vision-click 설명
- Skill install: + skills_ref 경로
- API 테이블: /act +mouse-click

---

## 7. 활성화 방법

```bash
cli-claw skill install vision-click   # skills_ref에서 자동 설치
cli-claw skill info vision-click      # SKILL.md 확인
```

---

## 8. Phase 2 로드맵

- `registry.json`에 `"cli_only": ["codex"]` 필드 추가
- `prompt.js`에서 현재 CLI에 맞는 스킬 조건부 주입
- Gemini/Claude REST API 직접 호출 provider 추가
- DPR(디스플레이 배율) 보정
- `cli-claw browser vision-click "target"` 원커맨드 통합
- vision-click 결과 캐싱
