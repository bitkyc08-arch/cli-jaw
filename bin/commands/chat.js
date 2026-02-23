/**
 * cli-claw chat — Phase 9.5 (polished v2)
 * Interactive REPL or --raw ndjson mode via WebSocket.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        raw: { type: 'boolean', default: false },
    },
    strict: false,
});

// ─── ANSI ────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
    white: '\x1b[97m',
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

// ─── Raw mode ────────────────────────────────
if (values.raw) {
    process.stdin.setEncoding('utf8');
    ws.on('message', (d) => process.stdout.write(d.toString() + '\n'));
    process.stdin.on('data', (chunk) => {
        for (const l of chunk.split('\n').filter(Boolean))
            ws.send(JSON.stringify({ type: 'send_message', text: l }));
    });
    process.stdin.on('end', () => { ws.close(); process.exit(0); });

} else {
    // ─── Banner (fixed width, no emoji in padding calc) ──
    const W = 48;
    const hr = '\u2500'.repeat(W);

    function row(left, right) {
        // plain padding — no ANSI in length calc
        const plain = left.replace(/\x1b\[[0-9;]*m/g, '') + right.replace(/\x1b\[[0-9;]*m/g, '');
        const gap = Math.max(1, W - plain.length);
        return `  \u2502 ${left}${' '.repeat(gap)}${right} \u2502`;
    }

    console.log('');
    console.log(`  \u250C\u2500${hr}\u2500\u2510`);
    console.log(row(`${c.bold}cli-claw${c.reset} ${c.dim}v0.1.0${c.reset}`, ''));
    console.log(row('', ''));
    console.log(row(`${c.dim}engine${c.reset}`, `${accent}${label}${c.reset}`));
    console.log(row(`${c.dim}directory${c.reset}`, `${c.cyan}${dir}${c.reset}`));
    console.log(row(`${c.dim}server${c.reset}`, `${c.green}\u25CF${c.reset} :${values.port}`));
    console.log(`  \u2514\u2500${hr}\u2500\u2518`);
    console.log('');

    // ─── Input box ───────────────────────────
    function drawInputBox() {
        process.stdout.write(`  ${c.dim}\u250C\u2500 message \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${c.reset}\n`);
        process.stdout.write(`  ${c.dim}\u2502${c.reset} `);
    }

    function closeInputBox() {
        process.stdout.write(`\n  ${c.dim}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${c.reset}\n`);
    }

    // ─── REPL ────────────────────────────────
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    let streaming = false;

    function showPrompt() {
        drawInputBox();
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            switch (msg.type) {
                case 'agent_chunk':
                    if (!streaming) {
                        streaming = true;
                        process.stdout.write(`\n  ${c.dim}\u250C\u2500 ${accent}${label}${c.reset}${c.dim} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${c.reset}\n  ${c.dim}\u2502${c.reset} `);
                    }
                    process.stdout.write((msg.text || '').replace(/\n/g, `\n  ${c.dim}\u2502${c.reset} `));
                    break;
                case 'agent_done':
                    if (streaming) {
                        process.stdout.write(`\n  ${c.dim}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${c.reset}\n\n`);
                        streaming = false;
                    } else if (msg.text) {
                        console.log(`\n  ${c.dim}\u250C\u2500 ${accent}${label}${c.reset}${c.dim} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${c.reset}`);
                        console.log(`  ${c.dim}\u2502${c.reset} ${msg.text.replace(/\n/g, `\n  ${c.dim}\u2502${c.reset} `)}`);
                        console.log(`  ${c.dim}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${c.reset}\n`);
                    }
                    showPrompt();
                    break;
                case 'agent_status':
                    if (msg.status === 'running') {
                        const name = msg.agentName || msg.agentId || 'agent';
                        process.stdout.write(`\r  ${c.yellow}\u25CF${c.reset} ${c.dim}${name} working...${c.reset}          \r`);
                    }
                    break;
                case 'new_message':
                    if (msg.source && msg.source !== 'cli') {
                        console.log(`  ${c.dim}[${msg.source}]${c.reset} ${(msg.content || '').slice(0, 60)}`);
                    }
                    break;
            }
        } catch { }
    });

    rl.on('line', (line) => {
        const text = line.trim();
        closeInputBox();
        if (!text) { showPrompt(); return; }
        if (text === '/quit' || text === '/exit' || text === '/q') {
            console.log(`\n  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
            ws.close(); rl.close(); process.exit(0);
        }
        if (text === '/clear') { console.clear(); showPrompt(); return; }
        ws.send(JSON.stringify({ type: 'send_message', text }));
    });

    rl.on('close', () => { ws.close(); process.exit(0); });
    ws.on('close', () => { console.log(`\n  ${c.dim}Connection closed${c.reset}\n`); process.exit(0); });

    showPrompt();
}
