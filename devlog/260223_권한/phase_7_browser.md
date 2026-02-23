# Phase 7 — 브라우저 조작

## OpenClaw 패턴 요약

OpenClaw은 MCP 대신 **CLI → HTTP → CDP/Playwright → Chrome** 파이프라인으로 브라우저 조작.
AI 에이전트가 shell tool로 `openclaw browser snapshot/click/type` 같은 CLI 명령을 실행.

핵심은 **ref 기반 스냅샷**: 페이지 요소에 e1, e2... ID를 붙여서 AI가 "e5 클릭" 가능.
좌표 기반(cliclick)보다 안정적 — 화면 크기, 스크롤 위치 무관.

---

## CLI-Claw에 적용할 전략

### 결론: SKILL.md + CDP 모듈 (별도 폴더 분리)

| 우선순위 | 항목                  | 난이도 | 영향도 |
| -------- | --------------------- | ------ | ------ |
| ⭐⭐⭐      | CDP 연결 + ref 스냅샷 | 중간   | 극대   |
| ⭐⭐⭐      | CLI 서브커맨드        | 낮음   | 극대   |
| ⭐⭐       | SKILL.md (AI 사용법)  | 낮음   | 높음   |
| ⭐        | doctor 체크           | 낮음   | 낮음   |

### 코드 분리 원칙

브라우저 코드는 **`src/browser/` 폴더에 완전 분리**. 기존 모듈(`agent.js`, `orchestrator.js` 등)과 의존 관계 0.

```
src/
├── agent.js            ← 기존 (터치 안 함)
├── orchestrator.js     ← 기존 (터치 안 함)
├── telegram.js         ← 기존 (터치 안 함)
├── bus.js / config.js / db.js / ...
└── browser/            ← 🆕 브라우저 전용 폴더
    ├── index.js        ← export 배럴 (외부에서 이것만 import)
    ├── connection.js   ← Chrome 시작/CDP 연결
    └── actions.js      ← snapshot/screenshot/click/type
```

- `browser/`는 `config.js`에서 `CLAW_HOME`만 가져옴
- `db.js`, `agent.js`, `orchestrator.js` 등 **일절 import 안 함**
- `playwright-core`는 일반 `dependencies` — M4 Mac Mini 기준 메모리/성능 영향 무시 가능

---

## 7.1 Chrome CDP 연결

#### [NEW] `src/browser/connection.js` (~100줄)

```js
import { CLAW_HOME } from '../config.js';
import { execSync, spawn } from 'child_process';
import { join } from 'path';

const DEFAULT_CDP_PORT = 9240;
const PROFILE_DIR = join(CLAW_HOME, 'browser-profile');
let cached = null;   // { browser, cdpUrl }
let chromeProc = null;

function findChrome() {
    const paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const p of paths) {
        try { execSync(`test -f "${p}"`); return p; } catch {}
    }
    throw new Error('Chrome not found — install Google Chrome');
}

import { chromium } from 'playwright-core';

export async function launchChrome(port = DEFAULT_CDP_PORT) {
    if (chromeProc && !chromeProc.killed) return;
    const chrome = findChrome();
    chromeProc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run', '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore' });
    chromeProc.unref();
    await new Promise(r => setTimeout(r, 2000));
}

export async function connectCdp(port = DEFAULT_CDP_PORT) {
    const cdpUrl = `http://127.0.0.1:${port}`;
    if (cached?.cdpUrl === cdpUrl && cached.browser.isConnected()) return cached;
    const browser = await chromium.connectOverCDP(cdpUrl);
    cached = { browser, cdpUrl };
    browser.on('disconnected', () => { cached = null; });
    return cached;
}

export async function getActivePage(port = DEFAULT_CDP_PORT, targetId) {
    const { browser } = await connectCdp(port);
    const pages = browser.contexts().flatMap(c => c.pages());
    if (targetId) {
        // CDP targetId 매칭 로직
        return pages[0]; // simplified
    }
    return pages[pages.length - 1] || null;
}

export async function listTabs(port = DEFAULT_CDP_PORT) {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await resp.json()).filter(t => t.type === 'page');
}

export async function getBrowserStatus(port = DEFAULT_CDP_PORT) {
    try {
        const tabs = await listTabs(port);
        return { running: true, tabs: tabs.length, cdpUrl: `http://127.0.0.1:${port}` };
    } catch { return { running: false, tabs: 0 }; }
}

export async function closeBrowser() {
    if (cached?.browser) { await cached.browser.close().catch(() => {}); cached = null; }
    if (chromeProc && !chromeProc.killed) { chromeProc.kill('SIGTERM'); chromeProc = null; }
}
```

### 파일 변경

| 파일                        | 변경                                    |
| --------------------------- | --------------------------------------- |
| `src/browser/connection.js` | [NEW] Chrome/CDP 연결 관리              |
| `package.json`              | `dependencies`에 `playwright-core` 추가 |

---

## 7.2 ref 스냅샷 + 액션

#### [NEW] `src/browser/actions.js` (~180줄)

```js
import { getActivePage } from './connection.js';
import { CLAW_HOME } from '../config.js';
import { join } from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = join(CLAW_HOME, 'screenshots');

// ─── ref 스냅샷 ────────────────────────────────

export async function snapshot(port, opts = {}) {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    const tree = await page.accessibility.snapshot();
    const nodes = [];
    let counter = 0;

    const interactive = ['button', 'link', 'textbox', 'checkbox',
        'radio', 'combobox', 'menuitem', 'tab', 'slider'];

    function walk(node, depth = 0) {
        if (!node) return;
        counter++;
        const ref = `e${counter}`;
        if (!opts.interactive || interactive.includes(node.role)) {
            nodes.push({
                ref, role: node.role || 'unknown',
                name: node.name || '',
                ...(node.value ? { value: node.value } : {}),
                depth,
            });
        }
        for (const child of node.children || []) walk(child, depth + 1);
    }
    walk(tree);
    return nodes;
}

// ─── ref → locator ─────────────────────────────

async function refToLocator(page, port, ref) {
    const nodes = await snapshot(port);
    const node = nodes.find(n => n.ref === ref);
    if (!node) throw new Error(`ref ${ref} not found`);
    return page.getByRole(node.role, { name: node.name });
}

// ─── 스크린샷 ───────────────────────────────────

export async function screenshot(port, opts = {}) {
    const page = await getActivePage(port, opts.targetId);
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
    return { path: filepath };
}

// ─── 조작 ───────────────────────────────────────

export async function click(port, ref, opts = {}) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    if (opts.doubleClick) await locator.dblclick();
    else await locator.click();
    return { ok: true, url: page.url() };
}

export async function type(port, ref, text, opts = {}) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.fill(text);
    if (opts.submit) await page.keyboard.press('Enter');
    return { ok: true };
}

export async function press(port, key) {
    const page = await getActivePage(port);
    await page.keyboard.press(key);
    return { ok: true };
}

export async function hover(port, ref) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.hover();
    return { ok: true };
}

export async function navigate(port, url) {
    const page = await getActivePage(port);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { ok: true, url: page.url() };
}

export async function evaluate(port, expression) {
    const page = await getActivePage(port);
    const result = await page.evaluate(expression);
    return { ok: true, result };
}

export async function getPageText(port, format = 'text') {
    const page = await getActivePage(port);
    if (format === 'html') return { text: await page.content() };
    return { text: await page.innerText('body') };
}
```

---

## 7.3 배럴 export

#### [NEW] `src/browser/index.js` (~15줄)

```js
export {
    launchChrome, connectCdp, getActivePage,
    listTabs, getBrowserStatus, closeBrowser,
} from './connection.js';

export {
    snapshot, screenshot, click, type, press,
    hover, navigate, evaluate, getPageText,
} from './actions.js';
```

---

## 7.4 CLI 서브커맨드

#### [NEW] `bin/commands/browser.js` (~180줄)

```js
import { parseArgs } from 'node:util';

const SERVER = `http://localhost:${process.env.PORT || 3457}`;
const sub = process.argv[3];

async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${SERVER}/api/browser${path}`, opts);
    return resp.json();
}

switch (sub) {
    case 'start': {
        const { values } = parseArgs({ args: process.argv.slice(4),
            options: { port: { type: 'string', default: '9240' } }, strict: false });
        const r = await api('POST', '/start', { port: Number(values.port) });
        console.log(r.running ? '🌐 Chrome started' : '❌ Failed');
        break;
    }
    case 'stop':
        await api('POST', '/stop');
        console.log('🌐 Chrome stopped');
        break;
    case 'status': {
        const r = await api('GET', '/status');
        console.log(`running: ${r.running}\ntabs: ${r.tabs}\ncdpUrl: ${r.cdpUrl || 'n/a'}`);
        break;
    }
    case 'snapshot': {
        const { values } = parseArgs({ args: process.argv.slice(4),
            options: { interactive: { type: 'boolean', default: false } }, strict: false });
        const r = await api('GET', `/snapshot?interactive=${values.interactive}`);
        for (const n of r.nodes || []) {
            const indent = '  '.repeat(n.depth);
            const val = n.value ? ` = "${n.value}"` : '';
            console.log(`${n.ref.padEnd(4)} ${indent}${n.role.padEnd(10)} "${n.name}"${val}`);
        }
        break;
    }
    case 'screenshot': {
        const { values } = parseArgs({ args: process.argv.slice(4),
            options: { 'full-page': { type: 'boolean' }, ref: { type: 'string' } }, strict: false });
        const r = await api('POST', '/screenshot', { fullPage: values['full-page'], ref: values.ref });
        console.log(r.path);
        break;
    }
    case 'click': {
        const ref = process.argv[4];
        if (!ref) { console.error('Usage: cli-claw browser click <ref>'); process.exit(1); }
        await api('POST', '/act', { kind: 'click', ref });
        console.log(`clicked ${ref}`);
        break;
    }
    case 'type': {
        const [ref, ...rest] = process.argv.slice(4);
        const text = rest.filter(a => !a.startsWith('--')).join(' ');
        const submit = rest.includes('--submit');
        await api('POST', '/act', { kind: 'type', ref, text, submit });
        console.log(`typed into ${ref}`);
        break;
    }
    case 'press':
        await api('POST', '/act', { kind: 'press', key: process.argv[4] });
        console.log(`pressed ${process.argv[4]}`);
        break;
    case 'navigate': {
        const r = await api('POST', '/navigate', { url: process.argv[4] });
        console.log(`navigated → ${r.url}`);
        break;
    }
    case 'tabs': {
        const r = await api('GET', '/tabs');
        (r.tabs || []).forEach((t, i) => console.log(`${i+1}. ${t.title}\n   ${t.url}`));
        break;
    }
    case 'text': {
        const { values } = parseArgs({ args: process.argv.slice(4),
            options: { format: { type: 'string', default: 'text' } }, strict: false });
        const r = await api('GET', `/text?format=${values.format}`);
        console.log(r.text);
        break;
    }
    case 'evaluate': {
        const r = await api('POST', '/evaluate', { expression: process.argv.slice(4).join(' ') });
        console.log(JSON.stringify(r.result, null, 2));
        break;
    }
    default:
        console.log(`
  🌐 cli-claw browser

  Commands:
    start [--port 9240]    Chrome 시작 (기본 CDP 포트: 9240)
    stop                   Chrome 종료
    status                 연결 상태

    snapshot               페이지 스냅샷 (ref ID 포함)
      --interactive        인터랙티브 요소만
    screenshot             스크린샷 캡처
      --full-page          전체 페이지
      --ref <ref>          특정 요소만
    click <ref>            요소 클릭
    type <ref> <text>      텍스트 입력 [--submit]
    press <key>            키 입력
    hover <ref>            호버
    navigate <url>         URL 이동
    tabs                   탭 목록
    text                   페이지 텍스트 [--format text|html]
    evaluate <js>          JS 실행
`);
}
```

#### [MODIFY] `bin/cli-claw.js`

```diff
     case 'status':
         await import('./commands/status.js');
         break;
+    case 'browser':
+        await import('./commands/browser.js');
+        break;
```

help 텍스트에 `browser` 추가:
```diff
     skill      스킬 관리 (install/remove/info)
     status     서버 상태 확인
+    browser    브라우저 조작 (snapshot/click/type)
```

---

## 7.5 서버 API 라우트

#### [MODIFY] `server.js` (~70줄 추가)

browser 폴더를 정적 import:

```js
// ─── Browser API ─────────────────────────────────────

import * as browser from './src/browser/index.js';

const cdpPort = () => settings.browser?.cdpPort || 9240;

app.post('/api/browser/start', async (req, res) => {
    try {
        await browser.launchChrome(req.body?.port || cdpPort());
        res.json(await browser.getBrowserStatus(cdpPort()));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/stop', async (_, res) => {
    try { await browser.closeBrowser(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/status', async (_, res) => {
    try { res.json(await browser.getBrowserStatus(cdpPort())); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/snapshot', async (req, res) => {
    try {
        res.json({ nodes: await browser.snapshot(cdpPort(), {
            interactive: req.query.interactive === 'true',
        })});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/screenshot', async (req, res) => {
    try { res.json(await browser.screenshot(cdpPort(), req.body)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/act', async (req, res) => {
    try {
        const { kind, ref, text, key, submit } = req.body;
        let result;
        switch (kind) {
            case 'click': result = await browser.click(cdpPort(), ref); break;
            case 'type': result = await browser.type(cdpPort(), ref, text, { submit }); break;
            case 'press': result = await browser.press(cdpPort(), key); break;
            case 'hover': result = await browser.hover(cdpPort(), ref); break;
            default: return res.status(400).json({ error: `unknown: ${kind}` });
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/browser/navigate', async (req, res) => {
    try { res.json(await browser.navigate(cdpPort(), req.body.url)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/tabs', async (_, res) => {
    try { res.json({ tabs: await browser.listTabs(cdpPort()) }); }
    catch { res.json({ tabs: [] }); }
});

app.post('/api/browser/evaluate', async (req, res) => {
    try { res.json(await browser.evaluate(cdpPort(), req.body.expression)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/browser/text', async (req, res) => {
    try { res.json(await browser.getPageText(cdpPort(), req.query.format)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
```

### 설정

```json
// ~/.cli-claw/settings.json
{
    "browser": {
        "cdpPort": 9240
    }
}
```

> 기본 포트 **9240** (9222-9229는 OpenClaw이 사용 중).
> `cli-claw browser start --port 9250`으로 오버라이드 가능.

---

## 7.6 브라우저 스킬

#### [NEW] `skills/browser/SKILL.md`

```yaml
---
name: browser
description: Chrome 브라우저 조작. 스냅샷으로 페이지 구조 확인 후 ref로 클릭/입력.
metadata:
  cli-claw:
    emoji: "🌐"
    requires:
      system: ["Google Chrome"]
---
# Browser Control

## Quick Start
cli-claw browser start
cli-claw browser navigate "https://example.com"
cli-claw browser snapshot       # 페이지 구조 → ref (e1, e2...)
cli-claw browser click e3       # 요소 클릭
cli-claw browser screenshot     # 스크린샷

## Workflow
1. snapshot → ref 목록 확인
2. click/type/press로 조작
3. snapshot으로 결과 확인 → 반복

## Commands
snapshot [--interactive]    screenshot [--full-page] [--ref]
click <ref>                 type <ref> <text> [--submit]
press <key>                 hover <ref>
navigate <url>              tabs
text [--format text|html]   evaluate <js>

## macOS 대안 (서버 없이)
screencapture -x ~/screenshot.png
osascript -e 'tell app "Chrome" to URL of active tab of front window'
```

---

## 7.7 doctor 체크

#### [MODIFY] `bin/commands/doctor.js` (~10줄, L81 뒤)

```js
check('Chrome', () => {
    if (fs.existsSync('/Applications/Google Chrome.app')) return 'installed';
    throw new Error('WARN: not installed — browser commands require Chrome');
});
check('playwright-core', () => {
    try { require.resolve('playwright-core'); return 'installed'; }
    catch { throw new Error('WARN: not installed — npm i playwright-core'); }
});
```

---

## 파일 변경 요약

| 파일                        | 유형   | 줄 수 | 의존성                     |
| --------------------------- | ------ | ----- | -------------------------- |
| `src/browser/connection.js` | NEW    | ~100  | config.js, playwright-core |
| `src/browser/actions.js`    | NEW    | ~180  | connection.js, config.js   |
| `src/browser/index.js`      | NEW    | ~15   | 배럴 export                |
| `bin/commands/browser.js`   | NEW    | ~180  | HTTP fetch only            |
| `skills/browser/SKILL.md`   | NEW    | ~40   | —                          |
| `server.js`                 | MODIFY | +70   | import browser/            |
| `bin/cli-claw.js`           | MODIFY | +5    | —                          |
| `bin/commands/doctor.js`    | MODIFY | +10   | —                          |
| `package.json`              | MODIFY | +1    | dependencies               |

## 체크리스트

- [x] 7.1: `src/browser/connection.js` — Chrome/CDP 연결 (기본 포트 9240)
- [x] 7.2: `src/browser/actions.js` — snapshot/screenshot/click/type (7.2에서 ariaSnapshot 기반으로 재작성)
- [x] 7.3: `src/browser/index.js` — 배럴 export
- [x] 7.4: `bin/commands/browser.js` — CLI 커맨드
- [x] 7.4: `bin/cli-claw.js`에 browser case 추가
- [x] 7.5: `server.js`에 `/api/browser/*` 라우트
- [x] 7.5: `settings.json`에 `browser.cdpPort` 설정
- [x] 7.6: `skills/browser/SKILL.md` 작성
- [x] 7.7: `doctor.js`에 Chrome/playwright-core 체크
- [x] `package.json` — `dependencies`에 playwright-core
- [x] 테스트: snapshot → click 사이클 (Phase 7.2 스모크 테스트 + 서버 API 테스트 통과)
- [x] 테스트: AI에서 `cli-claw browser` 실행

