/**
 * cli-claw chat — Phase 9.5 (polished v3)
 * Claude Code style: clean lines above/below input area.
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
const hr = () => '-'.repeat(W());

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
    // ─── Banner ──────────────────────────────
    console.log('');
    console.log(`  ${c.bold}cli-claw${c.reset} ${c.dim}v0.1.0${c.reset}`);
    console.log('');
    console.log(`  ${c.dim}engine:${c.reset}    ${accent}${label}${c.reset}`);
    console.log(`  ${c.dim}directory:${c.reset}  ${c.cyan}${dir}${c.reset}`);
    console.log(`  ${c.dim}server:${c.reset}    ${c.green}\u25CF${c.reset} localhost:${values.port}`);
    console.log('');
    console.log(`  ${c.dim}/quit to exit, /clear to reset${c.reset}`);

    // ─── Input prompt ────────────────────────
    const footer = `  ${c.dim}${accent}${label}${c.reset}${c.dim}  |  /quit  |  /clear${c.reset}`;

    function showInput() {
        console.log('');
        console.log(`  ${c.dim}${hr()}${c.reset}`);
        // Print prompt, save position, print bottom hr + footer, restore position
        process.stdout.write(`  ${accent}\u276F${c.reset} `);
        process.stdout.write('\x1b[s');  // save cursor
        process.stdout.write(`\n  ${c.dim}${hr()}${c.reset}`);
        process.stdout.write(`\n${footer}`);
        process.stdout.write('\x1b[u');  // restore cursor back to prompt
    }

    function onInputDone() {
        // Clear the bottom hr + footer that were below cursor (2 lines down)
        process.stdout.write('\x1b[s');       // save current pos
        process.stdout.write('\n\x1b[2K');    // move down, clear bottom hr
        process.stdout.write('\n\x1b[2K');    // move down, clear footer
        process.stdout.write('\x1b[u');       // restore
    }

    // ─── REPL ────────────────────────────────
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    let streaming = false;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            switch (msg.type) {
                case 'agent_chunk':
                    if (!streaming) {
                        streaming = true;
                        console.log('');
                        process.stdout.write(`  `);
                    }
                    process.stdout.write((msg.text || '').replace(/\n/g, '\n  '));
                    break;

                case 'agent_done':
                    if (streaming) {
                        console.log('');
                        streaming = false;
                    } else if (msg.text) {
                        console.log('');
                        console.log(`  ${msg.text.replace(/\n/g, '\n  ')}`);
                    }
                    showInput();
                    break;

                case 'agent_status':
                    if (msg.status === 'running') {
                        const name = msg.agentName || msg.agentId || 'agent';
                        process.stdout.write(`\r  ${c.yellow}\u25CF${c.reset} ${c.dim}${name} working...${c.reset}          \r`);
                    }
                    break;

                case 'new_message':
                    if (msg.source && msg.source !== 'cli') {
                        console.log(`\n  ${c.dim}[${msg.source}]${c.reset} ${(msg.content || '').slice(0, 60)}`);
                    }
                    break;

                case 'round_start':
                    console.log(`\n  ${c.cyan}\u25C6${c.reset} ${c.dim}Round ${msg.round}${c.reset}`);
                    break;
            }
        } catch { }
    });

    rl.on('line', (line) => {
        const text = line.trim();
        onInputDone();
        if (!text) { showInput(); return; }
        if (text === '/quit' || text === '/exit' || text === '/q') {
            console.log(`\n  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
            ws.close(); rl.close(); process.exit(0);
        }
        if (text === '/clear') { console.clear(); showInput(); return; }
        ws.send(JSON.stringify({ type: 'send_message', text }));
    });

    rl.on('close', () => { ws.close(); process.exit(0); });
    ws.on('close', () => { console.log(`\n  ${c.dim}Disconnected${c.reset}\n`); process.exit(0); });

    showInput();
}
