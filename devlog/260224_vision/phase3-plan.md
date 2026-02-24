---
created: 2026-02-24
tags: [vision-click, phase3, multi-provider, 구현계획]
status: planning
---

# Vision Click Phase 3 — Multi-Provider + cli_only + 캐싱

> Phase 2(Codex 원커맨드) 안정화 후 진행.
> Gemini/Claude REST API 프로바이더, CLI별 스킬 필터, 결과 캐싱.

---

## 목표

1. **Gemini/Claude REST API** — raw `fetch`로 비전 좌표 추출 (SDK 없음)
2. **settings.vision** — 프로바이더 선택 + API 키 관리 + 캐시 설정
3. **cli_only 필터** — Codex 아닌 CLI에서 vision-click 프롬프트 미주입
4. **결과 캐싱** — 동일 페이지+타겟 반복 호출 방지

---

## 변경 파일 (6개)

| #   | 파일                          | 액션    | 설명                                           |
| --- | ----------------------------- | ------- | ---------------------------------------------- |
| 1   | `src/browser/vision.js`       | MODIFY  | +geminiVision() + claudeVision() + auto-detect |
| 2   | `src/browser/vision-cache.js` | **NEW** | LRU 캐시 (sha256 키)                           |
| 3   | `src/config.js`               | MODIFY  | settings.vision 기본값                         |
| 4   | `server.js`                   | MODIFY  | deep-merge에 `'vision'` + 캐시 히트 로깅       |
| 5   | `src/prompt.js`               | MODIFY  | cli_only 프롬프트 필터                         |
| 6   | `skills_ref/registry.json`    | MODIFY  | cli_only 필드 추가                             |

---

## 1. `src/browser/vision.js` [MODIFY] — +Gemini, +Claude, +auto

Phase 2의 `extractCoordinates()` switch에 2개 프로바이더 추가:

```javascript
import { loadSettings } from '../config.js';

export async function extractCoordinates(screenshotPath, target, opts = {}) {
    const settings = loadSettings();
    const provider = opts.provider
        || settings.vision?.provider
        || detectBestProvider(settings);

    switch (provider) {
        case 'codex':  return codexVision(screenshotPath, target);
        case 'gemini': return geminiVision(screenshotPath, target, settings);
        case 'claude': return claudeVision(screenshotPath, target, settings);
        default: throw new Error(`Unknown vision provider: ${provider}`);
    }
}

/** Auto-detect: codex CLI 있으면 codex, 없으면 API 키 있는 provider */
function detectBestProvider(settings) {
    try { execSync('which codex', { stdio: 'pipe' }); return 'codex'; } catch {}
    if (settings.vision?.geminiApiKey || process.env.GEMINI_API_KEY) return 'gemini';
    if (settings.vision?.claudeApiKey || process.env.ANTHROPIC_API_KEY) return 'claude';
    throw new Error('No vision provider available. Install codex or set GEMINI_API_KEY/ANTHROPIC_API_KEY.');
}
```

### Gemini REST 프로바이더

```javascript
/**
 * Gemini vision provider — raw fetch, no SDK.
 * Uses generativelanguage.googleapis.com (v1beta)
 */
async function geminiVision(screenshotPath, target, settings) {
    const apiKey = settings.vision?.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY required for gemini provider');

    const imageData = fs.readFileSync(screenshotPath).toString('base64');
    const model = settings.vision?.geminiModel || 'gemini-2.5-flash';

    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            inline_data: {
                                mime_type: 'image/png',
                                data: imageData,
                            },
                        },
                        {
                            text: `Find "${target}" center pixel coordinate in this screenshot. `
                                + `Return ONLY valid JSON: {"found":true,"x":<int>,"y":<int>,"description":"<what you see>"} `
                                + `If not found: {"found":false,"x":0,"y":0,"description":"not found"}`,
                        },
                    ],
                }],
                generationConfig: {
                    temperature: 0,
                    maxOutputTokens: 256,
                    responseMimeType: 'application/json',
                },
            }),
        }
    );

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const json = await resp.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No response from Gemini');

    const coords = JSON.parse(text);
    return { ...coords, provider: 'gemini' };
}
```

### Claude REST 프로바이더

```javascript
/**
 * Claude vision provider — raw fetch, no SDK.
 * Uses api.anthropic.com/v1/messages
 */
async function claudeVision(screenshotPath, target, settings) {
    const apiKey = settings.vision?.claudeApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for claude provider');

    const imageData = fs.readFileSync(screenshotPath).toString('base64');
    const model = settings.vision?.claudeModel || 'claude-sonnet-4-6';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            max_tokens: 256,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: imageData,
                        },
                    },
                    {
                        type: 'text',
                        text: `Find "${target}" center pixel coordinate in this screenshot. `
                            + `Return ONLY valid JSON: {"found":true,"x":<int>,"y":<int>,"description":"<what you see>"} `
                            + `If not found: {"found":false,"x":0,"y":0,"description":"not found"}`,
                    },
                ],
            }],
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Claude API error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const json = await resp.json();
    const text = json.content?.[0]?.text;
    if (!text) throw new Error('No response from Claude');

    const coords = JSON.parse(text);
    return { ...coords, provider: 'claude' };
}
```

---

## 2. `src/browser/vision-cache.js` [NEW]

```javascript
/**
 * src/browser/vision-cache.js — LRU vision result cache
 * Key: sha256(url + target + screenshotBuffer).slice(0, 16)
 * TTL: 30s default (configurable via settings.vision.cacheTtlMs)
 */
import crypto from 'crypto';
import fs from 'fs';

const MAX_ENTRIES = 10;
const cache = new Map();  // key → { x, y, description, provider, ts }

export function generateCacheKey(pageUrl, target, screenshotPath) {
    const buf = fs.readFileSync(screenshotPath);
    return crypto.createHash('sha256')
        .update(pageUrl)
        .update(target)
        .update(buf)
        .digest('hex')
        .slice(0, 16);
}

export function get(key, ttlMs = 30000) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > ttlMs) {
        cache.delete(key);
        return null;
    }
    return entry;
}

export function set(key, result) {
    // LRU eviction
    if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { ...result, ts: Date.now() });
}

export function clear() {
    cache.clear();
}

export function stats() {
    return { size: cache.size, maxEntries: MAX_ENTRIES };
}
```

### vision.js 캐시 통합 (visionClick 수정)

```diff
+import * as visionCache from './vision-cache.js';
+import { getActivePage } from './connection.js';

 export async function visionClick(port, target, opts = {}) {
+    const settings = loadSettings();
+    const useCache = settings.vision?.cache !== false;
+
     const ss = await screenshot(port);
     const dpr = ss.dpr || 1;

+    // Cache check
+    let cacheKey = null;
+    if (useCache) {
+        const page = await getActivePage(port);
+        cacheKey = visionCache.generateCacheKey(page.url(), target, ss.path);
+        const cached = visionCache.get(cacheKey, settings.vision?.cacheTtlMs);
+        if (cached) {
+            const cssX = Math.round(cached.x / dpr);
+            const cssY = Math.round(cached.y / dpr);
+            await mouseClick(port, cssX, cssY, { doubleClick: opts.doubleClick });
+            return { success: true, clicked: {x: cssX, y: cssY}, cached: true, provider: cached.provider };
+        }
+    }

     const result = await extractCoordinates(ss.path, target, { provider: opts.provider });
     if (!result.found) return { success: false, reason: 'target not found' };

+    // Cache store
+    if (useCache && cacheKey) {
+        visionCache.set(cacheKey, result);
+    }

     const cssX = Math.round(result.x / dpr);
     const cssY = Math.round(result.y / dpr);
     await mouseClick(port, cssX, cssY, { doubleClick: opts.doubleClick });
     // ...
 }
```

---

## 3. `src/config.js` [MODIFY]

settings.vision 기본값:

```javascript
// DEFAULT_SETTINGS에 추가
vision: {
    provider: 'auto',        // 'auto' | 'codex' | 'gemini' | 'claude'
    geminiApiKey: '',         // or GEMINI_API_KEY env
    geminiModel: 'gemini-2.5-flash',
    claudeApiKey: '',         // or ANTHROPIC_API_KEY env
    claudeModel: 'claude-sonnet-4-6',
    dprCorrection: true,
    cache: true,
    cacheTtlMs: 30000,        // 30s
},
```

---

## 4. `server.js` [MODIFY]

deep-merge 목록에 `'vision'` 추가:

```diff
-for (const key of ['perCli', 'heartbeat', 'telegram', 'memory']) {
+for (const key of ['perCli', 'heartbeat', 'telegram', 'memory', 'vision']) {
```

---

## 5. `src/prompt.js` [MODIFY]

`getSystemPrompt()` vision-click 힌트에 cli_only 체크 추가:

```diff
     // ─── Vision-Click Hint (Codex only) ──────────────
     try {
         const session = getSession();
-        if (session.active_cli === 'codex') {
+        const cliOk = session.active_cli === 'codex'
+            || (settings.vision?.provider && settings.vision.provider !== 'codex');
+        if (cliOk) {
             const visionSkillPath = join(SKILLS_DIR, 'vision-click', 'SKILL.md');
```

`getMergedSkills()`에 `cli_only` 필드 전달:

```diff
 merged.push({
     ...s,
     enabled: false,
     source: 'ref',
+    cli_only: regInfo?.cli_only || null,
 });
```

---

## 6. `skills_ref/registry.json` [MODIFY]

vision-click 항목에 `cli_only` 추가:

```diff
 "vision-click": {
     ...
+    "cli_only": ["codex"],
+    "cli_enhanced": ["gemini", "claude"],
     "status": "active"
 }
```

---

## Verification Plan

### Gemini 테스트

```bash
# API 키 설정
curl -X PUT http://localhost:3457/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"vision":{"geminiApiKey":"AIza..."}}'

# Gemini vision-click
cli-claw browser vision-click "More information..." --provider gemini
# → 🖱️ vision-clicked ... at (x, y) via gemini
```

### Claude 테스트

```bash
ANTHROPIC_API_KEY=sk-ant-... cli-claw browser vision-click "Login" --provider claude
```

### Auto-detect 테스트

```bash
# codex 있으면 codex, 없으면 gemini, 둘 다 없으면 claude
cli-claw browser vision-click "Submit"
# → via codex (auto-detected)
```

### 캐시 테스트

```bash
# 1회차: cache miss → 비전 호출 (~3s)
cli-claw browser vision-click "Login"
# 2회차: cache hit → 즉시 (~0.1s)
cli-claw browser vision-click "Login"
```

### cli_only 테스트

```bash
# Gemini CLI 세션에서 getSystemPrompt() 확인
# → vision-click 힌트가 주입되지 않음 (unless vision.provider 설정)
```

---

## Phase 2 → Phase 3 마이그레이션 포인트

| Phase 2 코드                             | Phase 3 변경            |
| ---------------------------------------- | ----------------------- |
| `vision.js` switch에 codex만             | +gemini, +claude, +auto |
| `screenshot()` → `{path, dpr, viewport}` | 동일 (변경 없음)        |
| `visionClick()` 캐시 없음                | +vision-cache.js 통합   |
| `prompt.js` codex 하드코딩               | +cli_only 체크          |
| `settings` 에 vision 없음                | +settings.vision 추가   |
