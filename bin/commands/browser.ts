/**
 * cli-claw browser — Phase 7
 * Browser control via HTTP API to the server.
 */
import { parseArgs } from 'node:util';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getServerUrl } from '../../src/core/config.ts';

const SERVER = getServerUrl();
const sub = process.argv[3];
const CLAW_HOME = join(homedir(), '.cli-claw');

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${SERVER}/api/browser${path}`, opts);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `HTTP ${resp.status}`);
    }
    return resp.json();
}

try {
    switch (sub) {
        case 'start': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { port: { type: 'string', default: '9240' } }, strict: false
            });
            const r = await api('POST', '/start', { port: Number(values.port) });
            console.log(r.running ? `🌐 Chrome started (CDP: ${r.cdpUrl})` : '❌ Failed');
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
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { interactive: { type: 'boolean', default: false } }, strict: false
            });
            const r = await api('GET', `/snapshot?interactive=${values.interactive}`);
            for (const n of r.nodes || []) {
                const indent = '  '.repeat(n.depth);
                const val = n.value ? ` = "${n.value}"` : '';
                console.log(`${n.ref.padEnd(4)} ${indent}${n.role.padEnd(10)} "${n.name}"${val}`);
            }
            break;
        }
        case 'screenshot': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { 'full-page': { type: 'boolean' }, ref: { type: 'string' } }, strict: false
            });
            const r = await api('POST', '/screenshot', { fullPage: values['full-page'], ref: values.ref });
            console.log(r.path);
            break;
        }
        case 'click': {
            const ref = process.argv[4];
            if (!ref) { console.error('Usage: cli-claw browser click <ref>'); process.exit(1); }
            const opts = {};
            if (process.argv.includes('--double')) opts.doubleClick = true;
            await api('POST', '/act', { kind: 'click', ref, ...opts });
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
        case 'hover': {
            const ref = process.argv[4];
            await api('POST', '/act', { kind: 'hover', ref });
            console.log(`hovered ${ref}`);
            break;
        }
        case 'mouse-click': {
            const x = parseInt(process.argv[4]);
            const y = parseInt(process.argv[5]);
            if (isNaN(x) || isNaN(y)) {
                console.error('Usage: cli-claw browser mouse-click <x> <y> [--double]');
                process.exit(1);
            }
            const opts = {};
            if (process.argv.includes('--double')) opts.doubleClick = true;
            const r = await api('POST', '/act', { kind: 'mouse-click', x, y, ...opts });
            console.log(`🖱️ clicked at (${x}, ${y})`);
            break;
        }
        case 'vision-click': {
            const target = process.argv.slice(4).filter(a => !a.startsWith('--')).join(' ');
            if (!target) {
                console.error('Usage: cli-claw browser vision-click "<target>" [--provider codex] [--double]');
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
                console.log(`${c.red}❌ "${target}" not found: ${r.reason}${c.reset}`);
            }
            break;
        }
        case 'navigate': {
            const r = await api('POST', '/navigate', { url: process.argv[4] });
            console.log(`navigated → ${r.url}`);
            break;
        }
        case 'open': {
            const r = await api('POST', '/navigate', { url: process.argv[4] });
            console.log(`opened → ${r.url}`);
            break;
        }
        case 'tabs': {
            const r = await api('GET', '/tabs');
            (r.tabs || []).forEach((t, i) => console.log(`${i + 1}. ${t.title}\n   ${t.url}`));
            break;
        }
        case 'text': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { format: { type: 'string', default: 'text' } }, strict: false
            });
            const r = await api('GET', `/text?format=${values.format}`);
            console.log(r.text);
            break;
        }
        case 'evaluate': {
            const r = await api('POST', '/evaluate', { expression: process.argv.slice(4).join(' ') });
            console.log(JSON.stringify(r.result, null, 2));
            break;
        }
        case 'reset': {
            const force = process.argv.includes('--force');
            if (!force) {
                const { createInterface } = await import('node:readline');
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const answer = await new Promise(r => {
                    rl.question(`\n  ${c.yellow}⚠️  브라우저를 초기화합니다.${c.reset}\n  프로필, 스크린샷, CDP 캐시가 삭제됩니다.\n  계속하시겠습니까? (y/N): `, r);
                });
                rl.close();
                if (answer.toLowerCase() !== 'y') {
                    console.log('  취소됨.\n');
                    break;
                }
            }

            console.log(`\n  ${c.bold}🔄 브라우저 초기화 중...${c.reset}\n`);

            // 1. Stop browser (ignore errors if server not running)
            try {
                await api('POST', '/stop');
                console.log(`  ${c.dim}✓ browser stopped${c.reset}`);
            } catch {
                console.log(`  ${c.dim}✓ browser not running${c.reset}`);
            }

            // 2. Clear browser profile
            const profileDir = join(CLAW_HOME, 'browser-profile');
            if (existsSync(profileDir)) {
                rmSync(profileDir, { recursive: true, force: true });
                console.log(`  ${c.dim}✓ cleared ${profileDir}${c.reset}`);
            }

            // 3. Clear screenshots
            const screenshotsDir = join(CLAW_HOME, 'screenshots');
            if (existsSync(screenshotsDir)) {
                rmSync(screenshotsDir, { recursive: true, force: true });
                console.log(`  ${c.dim}✓ cleared ${screenshotsDir}${c.reset}`);
            }

            console.log(`\n  ${c.green}✅ 브라우저 초기화 완료!${c.reset}\n`);
            break;
        }
        default:
            console.log(`
  🌐 cli-claw browser

  Commands:
    start [--port 9240]    Start Chrome (default CDP port: 9240)
    stop                   Stop Chrome
    status                 Connection status
    reset [--force]        Reset (clear profile + screenshots)

    snapshot               Page snapshot with ref IDs
      --interactive        Interactive elements only
    screenshot             Capture screenshot
      --full-page          Full page
      --ref <ref>          Specific element only
    click <ref>            Click element [--double]
    mouse-click <x> <y>   Click at pixel coordinates [--double] (vision-click)
    vision-click <target>  Vision AI click [--provider codex] [--double]
    type <ref> <text>      Type text [--submit]
    press <key>            Press key (Enter, Tab, Escape...)
    hover <ref>            Hover element
    navigate <url>         Go to URL
    open <url>             Open URL (alias for navigate)
    tabs                   List tabs
    text                   Page text [--format text|html]
    evaluate <js>          Execute JavaScript
`);
    }
} catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
}

