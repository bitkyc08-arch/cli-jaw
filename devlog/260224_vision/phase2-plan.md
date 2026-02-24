---
created: 2026-02-24
tags: [vision-click, phase2, codex, 구현계획]
status: planning
---

# (fin) Vision Click Phase 2 — Codex 원커맨드 + DPR 보정

> Phase 1(수동 워크플로) → Phase 2(자동 원커맨드). Codex 전용.
>
> Phase 3에서 Gemini/Claude 프로바이더 + cli_only + 캐싱 추가 예정.

---

## 목표

**하나의 커맨드로 vision-click 전체 워크플로 실행:**

```bash
cli-claw browser vision-click "Login button"
# → screenshot → codex exec -i → DPR 보정 → mouseClick → 검증
```

---

## 변경 파일 (6개)

| #   | 파일                               | 액션    | 설명                               |
| --- | ---------------------------------- | ------- | ---------------------------------- |
| 1   | `src/browser/vision.js`            | **NEW** | 비전 좌표 추출 모듈                |
| 2   | `src/browser/actions.js`           | MODIFY  | screenshot() +dpr +viewport        |
| 3   | `src/browser/index.js`             | MODIFY  | +visionClick export                |
| 4   | `server.js`                        | MODIFY  | `/api/browser/vision-click` 라우트 |
| 5   | `bin/commands/browser.js`          | MODIFY  | vision-click CLI 서브커맨드        |
| 6   | `skills_ref/vision-click/SKILL.md` | MODIFY  | 원커맨드 문서 추가                 |

---

## 1. `src/browser/vision.js` [NEW]

비전 좌표 추출 모듈. Phase 2에서는 Codex 프로바이더만 구현.

```javascript
/**
 * src/browser/vision.js — Vision Click coordinate extraction
 * Phase 2: Codex provider only
 * Phase 3: + Gemini REST, Claude REST
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import { screenshot, mouseClick, snapshot } from './index.js';

/**
 * Extract click coordinates from screenshot using vision AI.
 * @param {string} screenshotPath - Path to screenshot image
 * @param {string} target - Description of element to find
 * @param {object} opts - { provider: 'codex' }
 * @returns {{ found: boolean, x: number, y: number, description?: string, provider: string }}
 */
export async function extractCoordinates(screenshotPath, target, opts = {}) {
    const provider = opts.provider || 'codex';
    switch (provider) {
        case 'codex': return codexVision(screenshotPath, target);
        default: throw new Error(`Unknown vision provider: ${provider}. Phase 2 supports 'codex' only.`);
    }
}

/**
 * Codex CLI vision provider.
 * Spawns `codex exec -i <image> --json` and parses NDJSON response.
 */
async function codexVision(screenshotPath, target) {
    // Get image dimensions for the prompt
    const prompt = [
        `Find "${target}" center pixel coordinate in this screenshot.`,
        `Return ONLY valid JSON: {"found":true,"x":<int>,"y":<int>,"description":"<what you see>"}`,
        `If not found: {"found":false,"x":0,"y":0,"description":"not found"}`,
    ].join(' ');

    return new Promise((resolve, reject) => {
        const args = [
            'exec', '-i', screenshotPath, '--json',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
            prompt,
        ];

        const child = spawn('codex', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000,
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);

        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`codex exec failed (code ${code}): ${stderr.slice(0, 200)}`));
            }

            // Parse NDJSON — look for agent_message with JSON coordinates
            try {
                const lines = stdout.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const event = JSON.parse(line);
                        if (event.item?.type === 'agent_message') {
                            // Extract JSON from the message text
                            const text = event.item.text || '';
                            const jsonMatch = text.match(/\{[^}]*"found"[^}]*\}/);
                            if (jsonMatch) {
                                const coords = JSON.parse(jsonMatch[0]);
                                return resolve({ ...coords, provider: 'codex' });
                            }
                        }
                    } catch { /* skip non-JSON lines */ }
                }
                reject(new Error('No coordinate JSON found in codex output'));
            } catch (e) {
                reject(new Error(`Failed to parse codex output: ${e.message}`));
            }
        });
    });
}

/**
 * Full vision-click pipeline: screenshot → vision → DPR correction → click → verify.
 * @param {number} port - CDP port
 * @param {string} target - Element description
 * @param {object} opts - { provider, doubleClick }
 */
export async function visionClick(port, target, opts = {}) {
    // 1. Screenshot
    const ss = await screenshot(port);
    const dpr = ss.dpr || 1;

    // 2. Vision → coordinates (image pixel space)
    const result = await extractCoordinates(ss.path, target, {
        provider: opts.provider || 'codex',
    });

    if (!result.found) {
        return { success: false, reason: 'target not found', provider: result.provider };
    }

    // 3. DPR correction: image pixels → CSS pixels
    const cssX = Math.round(result.x / dpr);
    const cssY = Math.round(result.y / dpr);

    // 4. Click
    await mouseClick(port, cssX, cssY, { doubleClick: opts.doubleClick });

    // 5. Verify (optional snapshot)
    let snap = null;
    try { snap = await snapshot(port, { interactive: true }); } catch { }

    return {
        success: true,
        clicked: { x: cssX, y: cssY },
        raw: { x: result.x, y: result.y },
        dpr,
        provider: result.provider,
        description: result.description,
        snap,
    };
}
```

---

## 2. `src/browser/actions.js` [MODIFY]

`screenshot()` 반환에 `dpr` + `viewport` 추가:

```diff
 export async function screenshot(port, opts = {}) {
     const page = await getActivePage(port);
     if (!page) throw new Error('No active page');
     fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

     const type = opts.type || 'png';
     const filename = `screenshot_${Date.now()}.${type}`;
     const filepath = join(SCREENSHOTS_DIR, filename);

     if (opts.ref) {
         const locator = await refToLocator(page, port, opts.ref);
         await locator.screenshot({ path: filepath, type });
     } else {
         await page.screenshot({ path: filepath, fullPage: opts.fullPage, type });
     }
-    return { path: filepath };
+    const dpr = await page.evaluate(() => window.devicePixelRatio);
+    const viewport = page.viewportSize();
+    return { path: filepath, dpr, viewport };
 }
```

**DPR 보정 원리:**
- Playwright `page.screenshot()`는 **실제 장치 픽셀** 기준 이미지 생성
- DPR=2 Retina: 뷰포트 1280×720 → 이미지 2560×1440px
- 비전 모델: 이미지 2560×1440px 기준 좌표 `{x:800, y:552}` 반환
- 보정: `cssX = 800 / 2 = 400`, `cssY = 552 / 2 = 276`
- `page.mouse.click(400, 276)` → 정확한 위치 ✅
- DPR=1: 보정 없음 (x/1 = x)

---

## 3. `src/browser/index.js` [MODIFY]

```diff
 export {
     snapshot, screenshot, click, type, press,
     hover, navigate, evaluate, getPageText,
     mouseClick,
 } from './actions.js';
+
+export { visionClick, extractCoordinates } from './vision.js';
```

---

## 4. `server.js` [MODIFY]

`/api/browser/vision-click` 엔드포인트 추가:

```javascript
// ─── Vision Click (Phase 2) ──────────────────────────
app.post('/api/browser/vision-click', async (req, res) => {
    try {
        const { target, provider, doubleClick } = req.body;
        if (!target) return res.status(400).json({ error: 'target required' });
        const result = await browser.visionClick(cdpPort(), target, { provider, doubleClick });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
```

---

## 5. `bin/commands/browser.js` [MODIFY]

`vision-click "target"` 서브커맨드:

```javascript
case 'vision-click': {
    const target = process.argv.slice(4).filter(a => !a.startsWith('--')).join(' ');
    if (!target) {
        console.error('Usage: cli-claw browser vision-click "<target description>" [--provider codex]');
        process.exit(1);
    }
    const opts = {};
    if (process.argv.includes('--double')) opts.doubleClick = true;
    const providerIdx = process.argv.indexOf('--provider');
    if (providerIdx !== -1) opts.provider = process.argv[providerIdx + 1];

    console.log(`${c.dim}👁️ vision-click: "${target}"...${c.reset}`);
    const r = await api('POST', '/vision-click', { target, ...opts });

    if (r.success) {
        console.log(`${c.green}🖱️ vision-clicked "${target}" at (${r.clicked.x}, ${r.clicked.y}) via ${r.provider}${c.reset}`);
        if (r.dpr !== 1) console.log(`${c.dim}   DPR=${r.dpr}, raw=(${r.raw.x}, ${r.raw.y})${c.reset}`);
    } else {
        console.log(`${c.red}❌ "${target}" not found${c.reset}`);
    }
    break;
}
```

help 텍스트에 추가:
```
    vision-click <target>  Vision-based click [--provider codex] [--double]
```

---

## 6. `skills_ref/vision-click/SKILL.md` [MODIFY]

기존 수동 워크플로 상단에 원커맨드 섹션 추가:

```markdown
## Quick Start (One Command)

```bash
cli-claw browser vision-click "Submit button"
# → screenshot → codex vision → DPR correction → click → verify
```

Equivalent manual steps:
1. `cli-claw browser screenshot`
2. `codex exec -i <path> --json 'Find "Submit" ...'`
3. `cli-claw browser mouse-click <x/dpr> <y/dpr>`
```

---

## Verification Plan

### 자동 테스트

```bash
# 1. DPR 확인
cli-claw browser start
cli-claw browser navigate "https://example.com"
node -e "
const pw = require('playwright-core');
pw.chromium.connectOverCDP('http://localhost:9240').then(async b => {
    const page = b.contexts()[0].pages()[0];
    console.log('DPR:', await page.evaluate(() => devicePixelRatio));
    console.log('viewport:', page.viewportSize());
    b.close();
});
"

# 2. screenshot DPR 반환 확인
curl -X POST http://localhost:3457/api/browser/screenshot
# → { "path": "...", "dpr": 2, "viewport": { "width": 1280, "height": 720 } }

# 3. vision-click E2E
cli-claw browser vision-click "More information..."
# → 🖱️ vision-clicked "More information..." at (x, y) via codex
# → DPR=2, raw=(2x, 2y)
cli-claw browser snapshot  # 페이지 이동 확인

# 4. API 직접 호출
curl -X POST http://localhost:3457/api/browser/vision-click \
  -H 'Content-Type: application/json' \
  -d '{"target":"More information...","provider":"codex"}'
```

### 수동 E2E

Canvas 앱이나 iframe 내부 요소에서:
```bash
cli-claw browser navigate "https://some-canvas-app.com"
cli-claw browser vision-click "Play" --provider codex
```
