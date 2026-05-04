/**
 * cli-jaw browser — Phase 7
 * Browser control via HTTP API to the server.
 */
import { parseArgs } from 'node:util';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getServerUrl, JAW_HOME, deriveCdpPort, loadSettings } from '../../src/core/config.js';
import { getCliAuthToken, authHeaders } from '../../src/cli/api-auth.js';
import { runWebAiCommand } from './browser-web-ai.js';

loadSettings();
const SERVER = getServerUrl();
await getCliAuthToken();
const sub = process.argv[3];

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

function formatRelativeAge(ms: number | null | undefined): string {
    if (!Number.isFinite(ms as number) || (ms as number) < 0) return 'untracked';
    if ((ms as number) < 1000) return 'now';
    const sec = Math.floor((ms as number) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function decorateTab(tab: Record<string, any>, now = Date.now()): Record<string, any> {
    const lastActiveAt = Number(tab.lastActiveAt);
    const idleForMs = Number.isFinite(lastActiveAt) && lastActiveAt > 0 ? now - lastActiveAt : null;
    return {
        ...tab,
        idleForMs,
        idleFor: idleForMs === null ? 'untracked' : formatRelativeAge(idleForMs),
        lastActiveAtIso: idleForMs === null ? null : new Date(lastActiveAt).toISOString(),
    };
}

try {
    switch (sub) {
        case 'web-ai':
            await runWebAiCommand(process.argv.slice(4), { api, qs });
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
            const runtime = r.runtime || {};
            const idleMs = Number(runtime.idleTimeoutMs);
            const idleClose = runtime.autoCloseEnabled
                ? `enabled after ${Number.isFinite(idleMs) ? `${Math.round(idleMs / 60000)}m` : 'configured timeout'}`
                : 'disabled';
            console.log([
                `running: ${r.running}`,
                `tabs: ${r.tabs}`,
                `cdpUrl: ${r.cdpUrl || 'n/a'}`,
                `owner: ${runtime.ownership || 'none'}`,
                `idleClose: ${idleClose}`,
            ].join('\n'));
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
            const tabs = (r.tabs || r.data?.tabs || []).map((tab: Record<string, any>) => decorateTab(tab));
            if (process.argv.includes('--json')) {
                console.log(JSON.stringify(tabs, null, 2));
                break;
            }
            tabs.forEach((t: any, i: number) => {
                const state = `${t.active ? 'active, ' : ''}idle ${t.idleFor}`;
                console.log(`${i + 1}. ${t.title}${t.title ? '' : '(untitled)'} [${state}]`);
                console.log(`   ${t.url}`);
                console.log(`   targetId: ${t.targetId}`);
            });
            console.log('\nTip: run "cli-jaw browser tab-cleanup" to close idle/overflow tabs.');
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
        case 'new-tab': {
            const url = process.argv[4] || 'about:blank';
            const activate = !process.argv.includes('--no-activate');
            const r = await api('POST', '/tab-new', { url, activate }) as Record<string, any>;
            console.log(`created tab: ${r.targetId} (${r.url})`);
            break;
        }
        case 'tab-close': {
            const target = process.argv[4];
            if (!target) { console.error('Usage: cli-jaw browser tab-close <targetId>'); process.exit(1); }
            const r = await api('POST', '/tab-close', { targetId: target }) as Record<string, any>;
            console.log(`closed tab: ${r.targetId}`);
            break;
        }
        case 'tab-cleanup': {
            const { values } = parseArgs({
                args: process.argv.slice(4),
                options: {
                    json: { type: 'boolean', default: false },
                    'idle-after': { type: 'string' },
                    'max-tabs': { type: 'string' },
                    'include-untracked': { type: 'boolean', default: false },
                    provider: { type: 'string' },
                    'keep-provider-tabs': { type: 'string' },
                    force: { type: 'boolean', default: false },
                },
                strict: false,
            });
            if (values['include-untracked'] === true && values.force !== true) {
                console.error('error: tab-cleanup --include-untracked requires --force');
                process.exit(1);
            }
            const r = await api('POST', '/tab-cleanup', {
                idleAfter: values['idle-after'],
                maxTabs: values['max-tabs'],
                includeUntracked: values['include-untracked'],
                provider: values.provider,
                keepProviderTabs: values['keep-provider-tabs'],
                force: values.force,
            }) as Record<string, any>;
            if (values.json) console.log(JSON.stringify(r, null, 2));
            else {
                console.log(`closed tabs: ${r.closed}`);
                console.log(`  lease pool: ${r.leaseClosed || 0}`);
                console.log(`  provider overflow: ${r.providerClosed || 0}`);
                console.log(`  idle timeout: ${r.idleClosed}`);
                console.log(`  max-tabs: ${r.limitClosed}`);
                console.log(`  untracked: ${r.untrackedClosed}`);
            }
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
  🌐 cli-jaw browser — CDP browser control and web-ai workflows

  Usage:
    cli-jaw browser <command> [args] [--flags]

  Quick start:
    cli-jaw browser status
    cli-jaw browser start --agent
    cli-jaw browser navigate "https://example.com"
    cli-jaw browser snapshot --interactive
    cli-jaw browser click e3

  Runtime model:
    cli-jaw browser talks to the cli-jaw server browser API.
    Browser profile, screenshots, web-ai sessions, and state live under JAW_HOME.
    Default automation mode uses a stable CDP browser unless --port overrides it.

  Lifecycle:
    start [--port <auto>] [--headless] [--agent]
      Start Chrome. --agent is the default automation path for headless/agent work.
    stop
      Stop Chrome.
    status
      Print running state, tab count, and CDP URL.
    reset [--force]
      Clear browser profile, screenshots, and CDP cache.

  Observe:
    snapshot [--interactive] [--max-nodes <n>]
      Print accessibility refs. Use --interactive before click/type.
    screenshot [--full-page] [--ref <ref>] [--clip x y w h] [--json]
      Capture viewport, full page, element ref, or CSS-pixel clip.
    text [--format text|html]
      Print page text or HTML.
    get-dom [--selector <css>] [--max-chars <n>] [--json]
      Print bounded DOM HTML for debugging selectors.

  Interact:
    click <ref> [--double] [--right]
      Click a ref from the last snapshot.
    type <ref> <text> [--submit]
      Type into an element and optionally press Enter.
    press <key>
      Press Enter, Tab, Escape, or another Playwright key.
    hover <ref>
      Hover an element ref.
    select <ref> <value>
      Select dropdown option(s).
    drag <fromRef> <toRef>
      Drag one ref to another.
    mouse-click <x> <y> [--double]
      Click CSS pixel coordinates.
    vision-click <target> [--provider codex] [--double]
      Use screenshot-to-coordinate AI click when no DOM ref exists.
    move-mouse <x> <y>
      Move the mouse pointer without clicking.
    mouse-down [--right] / mouse-up [--right]
      Low-level mouse button control.

  Navigation:
    navigate <url>
      Go to a URL.
    open <url>
      Alias for navigate.
    reload
      Reload the active page.
    resize <w> <h> [--fullscreen]
      Resize viewport/window.
    tabs [--json]
      List tabs with idle metadata.
    new-tab <url> [--no-activate]
      Create a browser tab.
    tab-close <targetId>
      Close a browser tab by CDP target id.
    tab-cleanup [--idle-after <30m>] [--max-tabs <n>] [--provider chatgpt] [--keep-provider-tabs 1] [--include-untracked --force] [--json]
      Close idle or overflow tabs. Active web-ai session tabs are preserved.
      --provider closes extra inactive provider tabs by origin; default keep is 1.
      JSON includes leaseClosed and leaseClosedTabs for pooled-tab close diagnostics.
    active-tab --json
      Show active tab target-id contract.
    tab-switch <index-or-targetId>
      Bring a tab to front and persist the active CDP target id.
    scroll [--x <dx>] [--y <dy>] [--ref <ref>]
      Scroll page or a specific element.

  Wait:
    wait-for-selector <css> [--timeout <ms>]
      Wait for a CSS selector.
    wait-for-text <text> [--timeout <ms>]
      Wait for visible text.

  Diagnostics:
    console [--json] [--clear] [--reload] [--duration <ms>] [--limit <n>]
      Read bounded console entries.
    network [--json] [--clear] [--reload] [--duration <ms>] [--filter <text>]
      Read redacted network entries.
    evaluate <js>
      Execute JavaScript in the active page.

  Web AI:
    web-ai render
      Render Oracle-style prompt envelope without sending.
    web-ai status
      Check verified provider tab state.
    web-ai send
      Send a prompt and store baseline/session.
    web-ai poll
      Poll for answer after baseline; supports --session and --allow-copy-markdown-fallback.
    web-ai query
      Send and poll in one command.
    web-ai watch
      Start long-running polling for a saved web-ai session.
    web-ai watchers
      List active long-running web-ai watchers.
    web-ai sessions
      List saved web-ai sessions.
    web-ai notifications
      List pending/sent web-ai completion notification events.
    web-ai capabilities
      List observed/provider capability schemas.
    web-ai diagnose
      Capture redacted diagnostics for the active web-ai page.
    web-ai stop
      Stop current provider generation with Escape.

    Common web-ai flags:
      --vendor <chatgpt|gemini|grok>
      --url <url>
      --model <alias>
      --effort <alias>                 ChatGPT only; requires --model.
                                       Pro: standard/extended
                                       Thinking: light/standard/extended/heavy
      --reasoning-effort <alias>       Alias for --effort
      --inline-only
      --file <path>
      --context-from-files <glob|path>
      --context-transport <upload|inline>
      --allow-copy-markdown-fallback
      --new-tab                        Force a fresh provider tab; default reuses pooled or inactive provider tabs first.
      --reuse-tab
      --json

    Tab lease policy:
      Completed provider tabs are runtime leases. The warm pool keeps max 1 owned
      tab per owner/vendor/sessionType/origin/profile key for 5m, then closes
      expired or overflow targets. Use tab-cleanup --json to inspect leaseClosedTabs.

    Examples:
      cli-jaw browser web-ai render --vendor chatgpt --prompt "hello" --json
      cli-jaw browser web-ai query --vendor grok --inline-only --prompt "Reply OK"
      cli-jaw browser web-ai query --vendor gemini --model thinking --inline-only --prompt "Reply OK"
      cli-jaw browser web-ai query --vendor chatgpt --context-from-files "src/**/*.ts" --context-transport upload --prompt "Review this"

  Notes:
    - Re-run snapshot after navigation; ref ids are snapshot-local.
    - Prefer tab-switch <targetId> before mutating when multiple provider tabs are open.
    - Use headed Chrome for live web-ai provider login/captcha flows.
    - Do not expose the CDP port to untrusted networks.
`);
    }
} catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exitCode = 1;
}
