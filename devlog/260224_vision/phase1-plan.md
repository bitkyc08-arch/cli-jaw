---
created: 2026-02-24
tags: [vision-click, phase1, codex, 구현계획]
status: planning
---

# Vision Click — Phase 1 구현계획

> **Codex-only**. `codex exec -i screenshot.png --json`으로 DOM 없는 요소 클릭.

---

## 배경

### 문제
브라우저 스킬의 ref 기반 `snapshot → click` 패턴은 DOM 요소만 대응 가능.
Canvas, iframe, Shadow DOM, 동적 렌더링 요소는 ref가 안 잡힘.

### 해결
스크린샷 → Codex 비전 모델에 전달 → 좌표 추출 → playwright `page.mouse.click(x, y)`.

### 제약
**Codex CLI만 지원**. 스모크 테스트(2026-02-24) 결과:
- ✅ `codex exec -i` — **±1px** 정확도
- ❌ `gemini -p` — stdin 바이너리 미지원 (Gemini REST API 직접 호출 필요)
- ❌ `claude -p` — `--print` 모드에서 비전 미지원 (Claude REST API 직접 호출 필요)

---

## 설계 결정

### Q1: 기존 browser 스킬에 추가 vs 새 스킬?

| 방법                                  | 장점                                      | 단점                                      |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| **A. browser 스킬 append**            | 한 곳에서 모든 브라우저 명령 관리         | Codex-only 기능이 뒤섞임, SKILL.md 비대화 |
| **B. 별도 `vision-click` 스킬**       | CLI별 분리 깔끔, 조건부 활성화 자연스러움 | 스킬 2개 관리 필요                        |
| **C. browser 스킬 + Codex 시 append** | 가장 유연                                 | 복잡한 조건부 로딩 로직 필요              |

**→ 선택: B. 별도 `vision-click` 스킬**

이유:
1. **Codex-only 제약을 SKILL.md에서 명시**할 수 있음
2. browser 스킬은 모든 CLI에서 동작하는 범용 스킬 — vision은 Codex 전용
3. registry.json에 `"requires": {"bins": ["codex"]}` 로 깔끔한 의존성 표현
4. 활성화는 **수동** (`cli-claw skill install vision-click`) — 자동 활성화는 Phase 2에서 고려

### Q2: 자동 활성화는?

> [!IMPORTANT]
> Phase 1에서는 **수동 활성화**로 시작. 이유:
> - 자동 활성화 로직(`settings.cli === 'codex'` 일 때 자동 주입)은 `prompt.js` 수정 필요
> - 현재 스킬 시스템은 `loadActiveSkills()`가 `~/.cli-claw/skills/` 폴더만 스캔
> - CLI별 조건부 활성화는 스킬 시스템 자체의 확장이 필요 → 별도 이슈
>
> Phase 2에서 `registry.json`에 `"cli_only": ["codex"]` 필드 추가 → `prompt.js`에서 현재 CLI에 맞는 스킬만 주입하는 방식으로 발전 가능.

### Q3: 에이전트가 자신의 비전 도구를 어떻게 인지?

1. **SKILL.md에 사용법 + 트리거 패턴 명시** → CLI 에이전트가 자동으로 읽음
2. **browser 스킬 하단에 vision-click 참조 추가** → "DOM에 ref 없으면 vision-click 스킬 참조"
3. **`A1_CONTENT`에 한 줄 추가** → "Codex 사용 시 vision-click 스킬로 DOM 외 요소 클릭 가능"

---

## 변경 사항

### 1. 새 스킬 생성

#### [NEW] `skills_ref/vision-click/SKILL.md`

```markdown
---
name: vision-click
description: "Vision-based click: screenshot → AI coordinate extraction → click. Codex CLI only."
metadata:
  openclaw:
    emoji: "👁️"
    requires:
      bins: ["codex", "cli-claw"]
      system: ["Google Chrome"]
---

# Vision Click (Codex Only)

Click non-DOM elements by screenshot analysis. Uses `codex exec -i` for vision.

## Prerequisites

- Codex CLI must be installed and configured
- cli-claw server running (for browser control)
- Browser must be started (`cli-claw browser start`)

## When to Use

Use vision-click when `cli-claw browser snapshot` returns NO ref for your target:
- Canvas elements, iframes, Shadow DOM
- Dynamically rendered content (WebGL, SVG drawings)
- Elements behind overlays or custom web components

## Commands

### vision-click: Find and click an element
cli-claw browser screenshot
codex exec -i /tmp/screenshot.png --json --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  'Screenshot is WxHpx. Find "TARGET" center pixel coordinate. Return ONLY JSON: { "found": true, "x": int, "y": int }'
# Then click with playwright coordinates
cli-claw browser mouse-click <x> <y>

### vision-query: Find element without clicking
codex exec -i /tmp/screenshot.png --json --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  'Describe what you see at the center of the screenshot.'

## Workflow

1. `cli-claw browser snapshot` → Check if target has a ref ID
2. If ref exists → use normal `cli-claw browser click <ref>`
3. If NO ref → fall back to vision-click:
   a. `cli-claw browser screenshot` → save to /tmp/
   b. `codex exec -i /tmp/screenshot.png --json` → get coordinates
   c. `cli-claw browser mouse-click <x> <y>` → click at coordinates
   d. `cli-claw browser snapshot` → verify click worked

## Limitations

- **Codex CLI only** — Gemini/Claude CLI cannot pass images
- Accuracy: ±1px (verified), but complex UIs may need retry
- Cost: ~$0.005-0.01 per vision call
- Latency: 2-5 seconds per call (includes model reasoning)
```

---

### 2. 레지스트리 등록

#### [MODIFY] `skills_ref/registry.json`

`"browser"` 항목 뒤에 추가:

```json
"vision-click": {
    "name": "Vision Click",
    "emoji": "👁️",
    "category": "automation",
    "description": "비전 기반 좌표 클릭. Codex CLI 전용. DOM 외 요소 대응.",
    "requires": {
        "bins": ["codex", "cli-claw"],
        "system": ["Google Chrome"]
    },
    "install": null,
    "canonical_id": "vision-click",
    "aliases": ["vision", "eye-click"],
    "workflow": "vision_coordinate",
    "provider": "openai",
    "status": "active"
}
```

---

### 3. 브라우저 커맨드 추가

#### [MODIFY] `bin/commands/browser.js`

`mouse-click` 서브커맨드 추가 (좌표 기반 클릭):

```javascript
case 'mouse-click': {
    const x = parseInt(process.argv[4]);
    const y = parseInt(process.argv[5]);
    if (isNaN(x) || isNaN(y)) {
        console.error('Usage: cli-claw browser mouse-click <x> <y>');
        process.exit(1);
    }
    const r = await api('POST', '/mouse-click', { x, y });
    if (r.success) console.log(`🖱️ clicked at (${x}, ${y})`);
    else console.error(`❌ ${r.error}`);
    break;
}
```

#### [MODIFY] `server.js`

`/api/browser/mouse-click` 라우트 추가:

```javascript
app.post('/api/browser/mouse-click', async (req, res) => {
    try {
        const { x, y, doubleClick } = req.body;
        const page = await getActivePage();
        if (doubleClick) await page.mouse.dblclick(x, y);
        else await page.mouse.click(x, y);
        res.json({ success: true, clicked: { x, y } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
```

---

### 4. browser 스킬에 참조 추가

#### [MODIFY] `skills_ref/browser/SKILL.md`

마지막에 1줄 추가:

```markdown
## Non-DOM Elements

If `snapshot` returns NO ref for your target, use the **vision-click** skill (Codex only).
See `skills_ref/vision-click/SKILL.md` for instructions.
```

---

### 5. (선택) 시스템 프롬프트에 힌트

#### [MODIFY] `src/prompt.js` → `A1_CONTENT`

Browser Control 섹션 하단에 1줄 추가:

```javascript
- If snapshot shows no ref for the target element and you are running on Codex, use the vision-click skill.
```

---

## 파일 변경 요약

| 파일                               | 액션    | 설명                              |
| ---------------------------------- | ------- | --------------------------------- |
| `skills_ref/vision-click/SKILL.md` | **NEW** | 비전 클릭 스킬 문서               |
| `skills_ref/registry.json`         | MODIFY  | vision-click 스킬 등록            |
| `bin/commands/browser.js`          | MODIFY  | `mouse-click <x> <y>` 커맨드 추가 |
| `server.js`                        | MODIFY  | `/api/browser/mouse-click` 라우트 |
| `skills_ref/browser/SKILL.md`      | MODIFY  | vision-click 참조 1줄 추가        |
| `src/prompt.js`                    | MODIFY  | A1_CONTENT에 힌트 1줄 추가 (선택) |

---

## 검증 계획

### 1. 자동 테스트 — Codex vision-click E2E

```bash
# 1. 서버 시작
cd ~/Developer/new/700_projects/cli-claw && node bin/cli-claw serve &

# 2. 브라우저 시작 + 페이지 열기
cli-claw browser start
cli-claw browser navigate "https://example.com"

# 3. 스크린샷 저장
cli-claw browser screenshot
# → /tmp/ 경로 확인

# 4. Codex vision 좌표 추출 테스트
codex exec -i <screenshot_path> --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  'Find "More information..." link. Return JSON: { "found": true, "x": int, "y": int }'

# 5. 좌표로 클릭
cli-claw browser mouse-click <x> <y>

# 6. snapshot으로 페이지 변경 확인
cli-claw browser snapshot
```

### 2. mouse-click 커맨드 단독 테스트

```bash
# mouse-click 기본 동작 확인
cli-claw browser start
cli-claw browser navigate "https://example.com"
cli-claw browser mouse-click 100 200
# → "🖱️ clicked at (100, 200)" 출력 확인
```

### 3. 수동 검증 — 사용자

사용자가 실제 Codex 에이전트 세션에서 "브라우저에서 LOGIN 버튼 클릭해줘" 같은 지시를 내렸을 때:
1. 에이전트가 snapshot → ref 없음 감지
2. vision-click 스킬 SKILL.md 읽기
3. screenshot → codex exec -i → mouse-click 패턴 수행
4. 클릭 성공 여부 확인

---

## Phase 2 로드맵 (미래)

- [ ] `registry.json`에 `"cli_only": ["codex"]` 필드 추가
- [ ] `prompt.js`에서 현재 CLI에 맞는 스킬 조건부 주입
- [ ] Gemini/Claude REST API 직접 호출 provider 추가
- [ ] vision-click 결과 캐싱 (동일 페이지 재분석 방지)
- [ ] `cli-claw browser vision-click "target"` 원커맨드 통합

---

## 변경 기록

- 2026-02-24: Phase 1 초안. Codex-only, 수동 활성화 방식.
