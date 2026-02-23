/**
 * cli-claw browser — Phase 7
 * Browser control via HTTP API to the server.
 */
import { parseArgs } from 'node:util';

const SERVER = `http://localhost:${process.env.PORT || 3457}`;
const sub = process.argv[3];

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
        default:
            console.log(`
  🌐 cli-claw browser

  Commands:
    start [--port 9240]    Start Chrome (default CDP port: 9240)
    stop                   Stop Chrome
    status                 Connection status

    snapshot               Page snapshot with ref IDs
      --interactive        Interactive elements only
    screenshot             Capture screenshot
      --full-page          Full page
      --ref <ref>          Specific element only
    click <ref>            Click element [--double]
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
