/**
 * cli-jaw browser — Phase 7
 * Browser control via HTTP API to the server.
 */
import { parseArgs } from 'node:util';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getServerUrl, JAW_HOME, deriveCdpPort, loadSettings } from '../../src/core/config.js';
import { getCliAuthToken, authHeaders } from '../../src/cli/api-auth.js';

loadSettings();
const SERVER = getServerUrl();
await getCliAuthToken();
const sub = process.argv[3];
const WEB_AI_COMMANDS = new Set(['render', 'status', 'send', 'poll', 'query', 'stop', 'diagnose']);

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

async function api(method: string, path: string, body?: any) {
    const opts: Record<string, any> = { method, headers: { ...authHeaders(), 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${SERVER}/api/browser${path}`, opts);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText })) as Record<string, any>;
        throw new Error(err.error || `HTTP ${resp.status}`);
    }
    return resp.json();
}

function qs(params: Record<string, any>) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== false) search.set(key, String(value));
    }
    const out = search.toString();
    return out ? `?${out}` : '';
}

function parseClip(values: Record<string, any>) {
    const clip = values.clip as string[] | undefined;
    if (!clip) return undefined;
    if (clip.length !== 4) throw new Error('--clip requires four values: x y width height');
    const [x, y, width, height] = clip.map(Number);
    if (![x, y, width, height].every(Number.isFinite)) throw new Error('--clip values must be numbers');
    return { x, y, width, height };
}

function rejectFutureWebAiFlags(values: Record<string, any>) {
    const vendor = values.vendor ?? 'chatgpt';
    if (vendor !== 'chatgpt' && vendor !== 'gemini') throw new Error(`unsupported vendor: ${vendor}`);
    if (values.file) throw new Error('--file is fail-closed (PRD32.7 Phase B pending). Use --inline-only.');
    if (values.model) throw new Error('--model is rejected-until-verified per capability registry.');
    if (values['thinking-time']) throw new Error('--thinking-time is reserved for 32.8B Gemini Deep Think.');
}

async function runWebAiCommand(args: string[]) {
    const command = args[0];
    if (!command || !WEB_AI_COMMANDS.has(command)) {
        throw new Error(`Usage: cli-jaw browser web-ai <${[...WEB_AI_COMMANDS].join('|')}> --vendor chatgpt`);
    }
    const { values } = parseArgs({
        args: args.slice(1),
        options: {
            vendor: { type: 'string', default: 'chatgpt' },
            prompt: { type: 'string' },
            system: { type: 'string' },
            project: { type: 'string' },
            goal: { type: 'string' },
            context: { type: 'string' },
            question: { type: 'string' },
            output: { type: 'string' },
            constraints: { type: 'string' },
            timeout: { type: 'string' },
            session: { type: 'string' },
            stage: { type: 'string' },
            'inline-only': { type: 'boolean', default: false },
            'allow-copy-markdown-fallback': { type: 'boolean', default: false },
            file: { type: 'string' },
            model: { type: 'string' },
            'thinking-time': { type: 'string' },
            json: { type: 'boolean', default: false },
        },
        strict: false,
    });
    rejectFutureWebAiFlags(values);
    const vendor = values.vendor ?? 'chatgpt';
    if (vendor === 'gemini' && command !== 'status' && command !== 'diagnose') {
        throw new Error('gemini runtime is contract-only (PRD32.8A). Use --vendor chatgpt or web-ai status --vendor gemini.');
    }
    if (['send', 'query'].includes(command) && !values['inline-only']) {
        throw new Error('web-ai send/query require --inline-only until PRD32.7 Phase B lands');
    }
    const body = {
        vendor: values.vendor,
        prompt: values.prompt,
        system: values.system,
        project: values.project,
        goal: values.goal,
        context: values.context,
        question: values.question,
        output: values.output,
        constraints: values.constraints,
        timeout: values.timeout,
        attachmentPolicy: 'inline-only',
    };
    const result = await callWebAiEndpoint(command, body, values);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printWebAiHuman(command, result as Record<string, any>);
}

async function callWebAiEndpoint(command: string, body: Record<string, any>, values: Record<string, any>) {
    if (command === 'status') return api('GET', `/web-ai/status${qs({ vendor: values.vendor })}`);
    if (command === 'poll') return api('GET', `/web-ai/poll${qs({ vendor: values.vendor, timeout: values.timeout, session: values.session, allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'] })}`);
    if (command === 'diagnose') return api('GET', `/web-ai/diagnose${qs({ vendor: values.vendor, stage: values.stage })}`);
    return api('POST', `/web-ai/${command}`, body);
}

function printWebAiHuman(command: string, result: Record<string, any>) {
    if (command === 'render') {
        console.log(result.rendered?.composerText || result.rendered?.markdown || '');
        if (result.warnings?.length) console.error(`[warnings] ${result.warnings.join(', ')}`);
        return;
    }
    if (result.answerText) {
        console.log(result.answerText);
        return;
    }
    console.log(`${result.status}: ${result.url || result.vendor || 'web-ai'}`);
}

try {
    switch (sub) {
        case 'web-ai':
            await runWebAiCommand(process.argv.slice(4));
            break;
        case 'start': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: {
                    port: { type: 'string', default: String(deriveCdpPort()) },
                    headless: { type: 'boolean', default: false },
                    agent: { type: 'boolean', default: false },
                }, strict: false
            });
            const r = await api('POST', '/start', {
                port: Number(values.port),
                headless: values.headless,
                mode: values.agent ? 'agent' : 'manual',
            }) as Record<string, any>;
            console.log(r.running ? `🌐 Chrome started (CDP: ${r.cdpUrl})` : '❌ Failed');
            break;
        }
        case 'stop':
            await api('POST', '/stop', {});
            console.log('🌐 Chrome stopped');
            break;
        case 'status': {
            const r = await api('GET', '/status') as Record<string, any>;
            console.log(`running: ${r.running}\ntabs: ${r.tabs}\ncdpUrl: ${r.cdpUrl || 'n/a'}`);
            break;
        }
        case 'snapshot': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: {
                    interactive: { type: 'boolean', default: false },
                    'max-nodes': { type: 'string' },
                    json: { type: 'boolean', default: false },
                }, strict: false
            });
            const r = await api('GET', `/snapshot${qs({
                interactive: values.interactive,
                'max-nodes': values['max-nodes'],
                json: values.json,
            })}`) as Record<string, any>;
            if (values.json) {
                console.log(JSON.stringify(r, null, 2));
                break;
            }
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
                options: {
                    'full-page': { type: 'boolean' },
                    ref: { type: 'string' },
                    clip: { type: 'string', multiple: true },
                    json: { type: 'boolean', default: false },
                }, strict: false
            });
            const r = await api('POST', '/screenshot', { fullPage: values['full-page'], ref: values.ref, clip: parseClip(values) }) as Record<string, any>;
            console.log(values.json ? JSON.stringify(r, null, 2) : r.path);
            break;
        }
        case 'click': {
            const ref = process.argv[4];
            if (!ref) { console.error('Usage: cli-jaw browser click <ref>'); process.exit(1); }
            const opts: Record<string, any> = {};
            if (process.argv.includes('--double')) opts.doubleClick = true;
            if (process.argv.includes('--right')) opts.button = 'right';
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
            const x = parseInt(process.argv[4]!);
            const y = parseInt(process.argv[5]!);
            if (isNaN(x) || isNaN(y)) {
                console.error('Usage: cli-jaw browser mouse-click <x> <y> [--double]');
                process.exit(1);
            }
            const opts: Record<string, any> = {};
            if (process.argv.includes('--double')) opts.doubleClick = true;
            const r = await api('POST', '/act', { kind: 'mouse-click', x, y, ...opts }) as Record<string, any>;
            console.log(`🖱️ clicked at (${x}, ${y})`);
            break;
        }
        case 'vision-click': {
            const { values, positionals } = parseArgs({
                args: process.argv.slice(4),
                allowPositionals: true,
                options: {
                    provider: { type: 'string' },
                    double: { type: 'boolean' },
                    'prepare-stable': { type: 'boolean' },
                    region: { type: 'string' },
                    clip: { type: 'string', multiple: true },
                    'verify-before-click': { type: 'boolean' },
                }, strict: false,
            });
            const target = positionals.join(' ');
            if (!target) {
                console.error('Usage: cli-jaw browser vision-click "<target>" [--provider codex] [--double]');
                process.exit(1);
            }
            const opts: Record<string, any> = {
                provider: values.provider,
                doubleClick: values.double,
                prepareStable: values['prepare-stable'],
                region: values.region,
                clip: parseClip(values),
                verifyBeforeClick: values['verify-before-click'],
            };

            console.log(`${c.dim}👁️ vision-click: "${target}"...${c.reset}`);
            const r = await api('POST', '/vision-click', { target, ...opts }) as Record<string, any>;

            if (r.success) {
                console.log(`${c.green}🖱️ vision-clicked "${target}" at (${r.clicked.x}, ${r.clicked.y}) via ${r.provider}${c.reset}`);
                if (r.dpr !== 1) console.log(`${c.dim}   DPR=${r.dpr}, raw=(${r.raw.x}, ${r.raw.y})${c.reset}`);
            } else {
                console.log(`${c.red}❌ "${target}" not found: ${r.reason}${c.reset}`);
            }
            break;
        }
        case 'navigate': {
            const r = await api('POST', '/navigate', { url: process.argv[4] }) as Record<string, any>;
            console.log(`navigated → ${r.url}`);
            break;
        }
        case 'open': {
            const r = await api('POST', '/navigate', { url: process.argv[4] }) as Record<string, any>;
            console.log(`opened → ${r.url}`);
            break;
        }
        case 'tabs': {
            const r = await api('GET', '/tabs') as Record<string, any>;
            if (process.argv.includes('--json')) {
                console.log(JSON.stringify(r.tabs || r.data?.tabs || [], null, 2));
                break;
            }
            (r.tabs || r.data?.tabs || []).forEach((t: any, i: number) => console.log(`${i + 1}. ${t.title}\n   ${t.url}`));
            break;
        }
        case 'active-tab': {
            const r = await api('GET', '/active-tab') as Record<string, any>;
            console.log(JSON.stringify(r, null, 2));
            break;
        }
        case 'tab-switch': {
            const target = process.argv[4];
            if (!target) { console.error('Usage: cli-jaw browser tab-switch <index-or-targetId>'); process.exit(1); }
            const r = await api('POST', '/tab-switch', { target }) as Record<string, any>;
            console.log(JSON.stringify(r, null, 2));
            break;
        }
        case 'text': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { format: { type: 'string', default: 'text' } }, strict: false
            });
            const r = await api('GET', `/text?format=${values.format}`) as Record<string, any>;
            console.log(r.text);
            break;
        }
        case 'get-dom': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { selector: { type: 'string' }, 'max-chars': { type: 'string' }, json: { type: 'boolean' } },
                strict: false,
            });
            const r = await api('GET', `/dom${qs({ selector: values.selector, 'max-chars': values['max-chars'] })}`) as Record<string, any>;
            console.log(values.json ? JSON.stringify(r, null, 2) : r.html);
            break;
        }
        case 'wait-for-selector': {
            const selector = process.argv[4];
            const { values } = parseArgs({
                args: process.argv.slice(5),
                options: { timeout: { type: 'string' }, state: { type: 'string' } },
                strict: false,
            });
            await api('POST', '/wait-for-selector', { selector, timeout: values.timeout, state: values.state });
            console.log(`waited for selector ${selector}`);
            break;
        }
        case 'wait-for-text': {
            const { values, positionals } = parseArgs({
                args: process.argv.slice(4),
                allowPositionals: true,
                options: { timeout: { type: 'string' } },
                strict: false,
            }) as { values: Record<string, any>; positionals: string[] };
            const text = positionals.join(' ');
            await api('POST', '/wait-for-text', { text, timeout: values.timeout });
            console.log(`waited for text ${text}`);
            break;
        }
        case 'reload': {
            const r = await api('POST', '/reload', {}) as Record<string, any>;
            console.log(`reloaded → ${r.url}`);
            break;
        }
        case 'resize': {
            await api('POST', '/resize', { width: Number(process.argv[4]), height: Number(process.argv[5]) });
            console.log(`resized to ${process.argv[4]}x${process.argv[5]}`);
            break;
        }
        case 'scroll': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { x: { type: 'string' }, y: { type: 'string' }, ref: { type: 'string' } },
                strict: false,
            });
            await api('POST', '/act', { kind: 'scroll', x: Number(values.x || 0), y: Number(values.y || 0), ref: values.ref });
            console.log('scrolled');
            break;
        }
        case 'select': {
            const [ref, ...values] = process.argv.slice(4);
            await api('POST', '/act', { kind: 'select', ref, values });
            console.log(`selected ${values.join(', ')} in ${ref}`);
            break;
        }
        case 'drag': {
            await api('POST', '/act', { kind: 'drag', fromRef: process.argv[4], toRef: process.argv[5] });
            console.log(`dragged ${process.argv[4]} to ${process.argv[5]}`);
            break;
        }
        case 'move-mouse': {
            await api('POST', '/act', { kind: 'move-mouse', x: Number(process.argv[4]), y: Number(process.argv[5]) });
            console.log(`moved mouse to (${process.argv[4]}, ${process.argv[5]})`);
            break;
        }
        case 'mouse-down':
        case 'mouse-up': {
            const button = process.argv.includes('--right') ? 'right' : 'left';
            await api('POST', '/act', { kind: sub, button });
            console.log(sub);
            break;
        }
        case 'console': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { json: { type: 'boolean' }, limit: { type: 'string' }, clear: { type: 'boolean' } },
                strict: false,
            });
            const r = await api('GET', `/console${qs({ limit: values.limit, clear: values.clear })}`) as Record<string, any>;
            console.log(values.json ? JSON.stringify(r, null, 2) : (r.entries || []).map((e: any) => `[${e.type}] ${e.text}`).join('\n'));
            break;
        }
        case 'network': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: { json: { type: 'boolean' }, limit: { type: 'string' }, filter: { type: 'string' } },
                strict: false,
            });
            const r = await api('GET', `/network${qs({ limit: values.limit, filter: values.filter })}`) as Record<string, any>;
            console.log(values.json ? JSON.stringify(r, null, 2) : (r.entries || []).map((e: any) => `${e.method} ${e.origin}${e.path || ''}`).join('\n'));
            break;
        }
        case 'evaluate': {
            const r = await api('POST', '/evaluate', { expression: process.argv.slice(4).join(' ') }) as Record<string, any>;
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
                if ((answer as string).toLowerCase() !== 'y') {
                    console.log('  취소됨.\n');
                    break;
                }
            }

            console.log(`\n  ${c.bold}🔄 브라우저 초기화 중...${c.reset}\n`);

            // 1. Stop browser (ignore errors if server not running)
            try {
                await api('POST', '/stop', {});
                console.log(`  ${c.dim}✓ browser stopped${c.reset}`);
            } catch {
                console.log(`  ${c.dim}✓ browser not running${c.reset}`);
            }

            // 2. Clear browser profile
            const profileDir = join(JAW_HOME, 'browser-profile');
            if (existsSync(profileDir)) {
                rmSync(profileDir, { recursive: true, force: true });
                console.log(`  ${c.dim}✓ cleared ${profileDir}${c.reset}`);
            }

            // 3. Clear screenshots
            const screenshotsDir = join(JAW_HOME, 'screenshots');
            if (existsSync(screenshotsDir)) {
                rmSync(screenshotsDir, { recursive: true, force: true });
                console.log(`  ${c.dim}✓ cleared ${screenshotsDir}${c.reset}`);
            }

            console.log(`\n  ${c.green}✅ 브라우저 초기화 완료!${c.reset}\n`);
            break;
        }
        default:
            console.log(`
  🌐 cli-jaw browser

  Commands:
    start [--port <auto>] [--headless] [--agent]  Start Chrome
    stop                   Stop Chrome
    status                 Connection status
    reset [--force]        Reset (clear profile + screenshots)

    snapshot               Page snapshot with ref IDs
      --interactive        Interactive elements only
    screenshot             Capture screenshot
      --full-page          Full page
      --ref <ref>          Specific element only
      --clip x y w h       Screenshot clip
      --json               Print metadata as JSON
    click <ref>            Click element [--double]
      --right              Right-click element
    mouse-click <x> <y>   Click at pixel coordinates [--double] (vision-click)
    vision-click <target>  Vision AI click [--provider codex] [--double]
    type <ref> <text>      Type text [--submit]
    press <key>            Press key (Enter, Tab, Escape...)
    hover <ref>            Hover element
    navigate <url>         Go to URL
    open <url>             Open URL (alias for navigate)
    tabs [--json]          List tabs
    active-tab --json      Show active tab contract
    tab-switch <target>    Bring tab index or targetId to front
    text                   Page text [--format text|html]
    get-dom                DOM HTML [--selector <css>] [--max-chars <n>] [--json]
    wait-for-selector      Wait for CSS selector
    wait-for-text          Wait for visible text
    reload                 Reload active page
    resize <w> <h>         Resize viewport
    scroll                 Scroll page [--x <dx>] [--y <dy>] [--ref <ref>]
    select <ref> <value>   Select option(s)
    drag <fromRef> <toRef> Drag element to element
    move-mouse <x> <y>     Move mouse pointer
    mouse-down/up          Low-level mouse buttons [--right]
    console                Read bounded console entries [--json]
    network                Read redacted network entries [--json]
    evaluate <js>          Execute JavaScript
    web-ai render           Render Oracle-style ChatGPT prompt envelope
    web-ai status           Check verified ChatGPT active tab (or Gemini contract-only status)
    web-ai send             Send inline-only prompt to ChatGPT
    web-ai poll             Poll for answer after baseline (--session optional, --allow-copy-markdown-fallback opt-in)
    web-ai query            Send and poll in one command
    web-ai stop             Stop current generation with Escape
    web-ai diagnose         Capture redacted diagnostics for the active web-ai page
`);
    }
} catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exitCode = 1;
}
