/**
 * cli-claw chat — Phase 9.5
 * Three modes: default (raw stdin, persistent footer), --raw (JSON in UI), --simple (plain readline)
 */
import * as readline from 'node:readline';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        raw: { type: 'boolean', default: false },
        simple: { type: 'boolean', default: false },
    },
    strict: false,
});

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ─── Connect ─────────────────────────────────
const wsUrl = `ws://localhost:${values.port}`;
const apiUrl = `http://localhost:${values.port}`;

let ws;
try {
    ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(wsUrl);
        s.on('open', () => resolve(s));
        s.on('error', reject);
    });
} catch {
    console.error(`\n  ${c.red}x${c.reset} Cannot connect to ${wsUrl}`);
    console.error(`  Run ${c.cyan}cli-claw serve${c.reset} first\n`);
    process.exit(1);
}

// ─── Fetch info ──────────────────────────────
let info = { cli: 'codex', workingDir: '~' };
try {
    const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) { const s = await r.json(); info = { cli: s.cli || 'codex', workingDir: s.workingDir || '~' }; }
} catch { }

const cliLabel = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
const cliColor = { claude: c.magenta, codex: c.red, gemini: c.blue };
const accent = cliColor[info.cli] || c.red;
const label = cliLabel[info.cli] || info.cli;
const dir = info.workingDir.replace(process.env.HOME, '~');

// ─── Width helper ────────────────────────────
const W = () => Math.max(20, Math.min((process.stdout.columns || 60) - 4, 60));
const hrLine = () => '-'.repeat(W());

// ─── Simple mode (plain readline, no tricks) ──
if (values.simple) {
    console.log(`\n  cli-claw v0.1.0 · ${label} · :${values.port}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${label} > ` });
    let streaming = false;
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'agent_chunk') { if (!streaming) streaming = true; process.stdout.write(msg.text || ''); }
            else if (msg.type === 'agent_done') {
                if (streaming) { process.stdout.write('\n\n'); streaming = false; }
                else if (msg.text) console.log(msg.text + '\n');
                rl.prompt();
            }
            else if (msg.type === 'agent_status' && msg.status === 'running')
                process.stdout.write(`[${msg.agentName || msg.agentId}] working...\r`);
        } catch { }
    });
    rl.on('line', (line) => {
        const t = line.trim();
        if (!t) { rl.prompt(); return; }
        if (t === '/quit' || t === '/q') { ws.close(); rl.close(); process.exit(0); }
        ws.send(JSON.stringify({ type: 'send_message', text: t }));
    });
    rl.on('close', () => { ws.close(); process.exit(0); });
    ws.on('close', () => { console.log('Disconnected'); process.exit(0); });
    rl.prompt();

} else {
    // ─── Default + Raw — shared UI with raw stdin ──
    const isRaw = values.raw;

    // Banner
    console.log('');
    console.log(`  ${c.bold}cli-claw${c.reset} ${c.dim}v0.1.0${c.reset}${isRaw ? `  ${c.dim}(raw json)${c.reset}` : ''}`);
    console.log('');
    console.log(`  ${c.dim}engine:${c.reset}    ${accent}${label}${c.reset}`);
    console.log(`  ${c.dim}directory:${c.reset}  ${c.cyan}${dir}${c.reset}`);
    console.log(`  ${c.dim}server:${c.reset}    ${c.green}\u25CF${c.reset} localhost:${values.port}`);
    console.log('');
    console.log(`  ${c.dim}/quit to exit, /clear to reset${c.reset}`);

    const footer = `  ${c.dim}${accent}${label}${c.reset}${c.dim}  |  /quit  |  /clear${c.reset}`;
    const promptPrefix = `  ${accent}\u276F${c.reset} `;

    // ─── State ───────────────────────────────
    let inputBuf = '';
    let inputActive = true;
    let streaming = false;

    // Track which "row" the prompt is on (for cursor movement)
    // We draw: [blank] [top hr] [prompt] [bottom hr] [footer]
    // Prompt row = current cursor, bottom hr = +1, footer = +2

    function drawInputBox() {
        console.log('');
        console.log(`  ${c.dim}${hrLine()}${c.reset}`);
        process.stdout.write(promptPrefix);
        // Save cursor, draw below, restore
        process.stdout.write('\x1b[s');
        process.stdout.write(`\n  ${c.dim}${hrLine()}${c.reset}`);
        process.stdout.write(`\n${footer}`);
        process.stdout.write('\x1b[u');
    }

    function redrawPromptLine() {
        // Move to column 0 of current line, clear it, redraw prompt + buffer
        process.stdout.write('\r\x1b[2K');
        process.stdout.write(promptPrefix + inputBuf);
    }

    function clearBelowAndPrint() {
        // Move down 2 lines (bottom hr + footer), clear them, move back, then go down
        process.stdout.write('\x1b[s');
        process.stdout.write('\n\x1b[2K\n\x1b[2K');
        process.stdout.write('\x1b[u\n');
    }

    // ─── Raw stdin input ─────────────────────
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
        if (!inputActive) return;

        if (key === '\r' || key === '\n') {
            // Enter
            const text = inputBuf.trim();
            inputBuf = '';
            clearBelowAndPrint();

            if (!text) { drawInputBox(); return; }
            if (text === '/quit' || text === '/exit' || text === '/q') {
                console.log(`  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
                ws.close();
                process.stdin.setRawMode(false);
                process.exit(0);
            }
            if (text === '/clear') {
                console.clear();
                drawInputBox();
                return;
            }
            ws.send(JSON.stringify({ type: 'send_message', text }));
            inputActive = false;
        } else if (key === '\x7f' || key === '\b') {
            // Backspace
            if (inputBuf.length > 0) {
                inputBuf = inputBuf.slice(0, -1);
                redrawPromptLine();
            }
        } else if (key === '\x03') {
            // Ctrl+C
            console.log(`\n  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
            ws.close();
            process.stdin.setRawMode(false);
            process.exit(0);
        } else if (key === '\x15') {
            // Ctrl+U — clear line
            inputBuf = '';
            redrawPromptLine();
        } else if (key.charCodeAt(0) >= 32 || key.charCodeAt(0) > 127) {
            // Printable chars (including multibyte/Korean)
            inputBuf += key;
            redrawPromptLine();
        }
    });

    // ─── WS messages ─────────────────────────
    ws.on('message', (data) => {
        const raw = data.toString();
        try {
            const msg = JSON.parse(raw);
            switch (msg.type) {
                case 'agent_chunk':
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                        break;
                    }
                    if (!streaming) {
                        streaming = true;
                        console.log('');
                        process.stdout.write('  ');
                    }
                    process.stdout.write((msg.text || '').replace(/\n/g, '\n  '));
                    break;

                case 'agent_done':
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (streaming) {
                        console.log('');
                    } else if (msg.text) {
                        console.log('');
                        console.log(`  ${msg.text.replace(/\n/g, '\n  ')}`);
                    }
                    streaming = false;
                    inputActive = true;
                    drawInputBox();
                    break;

                case 'agent_status':
                    // skip 'done' — redundant with agent_done, arrives late
                    if (msg.status === 'done') break;
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (msg.status === 'running') {
                        const name = msg.agentName || msg.agentId || 'agent';
                        process.stdout.write(`\r  ${c.yellow}\u25CF${c.reset} ${c.dim}${name} working...${c.reset}          \r`);
                    }
                    break;

                case 'new_message':
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (msg.source && msg.source !== 'cli') {
                        console.log(`\n  ${c.dim}[${msg.source}]${c.reset} ${(msg.content || '').slice(0, 60)}`);
                    }
                    break;

                default:
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    }
                    break;
            }
        } catch { }
    });

    ws.on('close', () => {
        console.log(`\n  ${c.dim}Disconnected${c.reset}\n`);
        process.stdin.setRawMode(false);
        process.exit(0);
    });

    drawInputBox();
}
