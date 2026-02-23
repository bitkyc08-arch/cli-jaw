/**
 * cli-claw chat — Phase 9.5
 * Three modes: default (raw stdin, persistent footer), --raw (JSON in UI), --simple (plain readline)
 */
import * as readline from 'node:readline';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import fs from 'node:fs';
import { resolve as resolvePath } from 'node:path';

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
        // Phase 10: /file command
        if (t.startsWith('/file ')) {
            const parts = t.slice(6).trim().split(/\s+/);
            const fp = resolvePath(parts[0]);
            const caption = parts.slice(1).join(' ');
            if (!fs.existsSync(fp)) { console.log(`  ${c.red}파일 없음: ${fp}${c.reset}`); rl.prompt(); return; }
            const prompt = `[사용자가 파일을 보냈습니다: ${fp}]\n이 파일을 Read 도구로 읽고 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
            ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
            return;
        }
        // Phase 12.1: /mcp command
        if (t === '/mcp' || t.startsWith('/mcp ')) {
            const sub = t.slice(4).trim();
            if (sub === 'sync') {
                fetch(`${apiUrl}/api/mcp/sync`, { method: 'POST' })
                    .then(r => r.json())
                    .then(d => { console.log(`  ${c.green}MCP synced:${c.reset}`, JSON.stringify(d.results)); rl.prompt(); })
                    .catch(e => { console.log(`  ${c.red}${e.message}${c.reset}`); rl.prompt(); });
            } else if (sub === 'install') {
                console.log(`  ${c.yellow}📦 Installing MCP servers globally...${c.reset}`);
                fetch(`${apiUrl}/api/mcp/install`, { method: 'POST' })
                    .then(r => r.json())
                    .then(d => {
                        for (const [n, v] of Object.entries(d.results || {})) {
                            const icon = v.status === 'installed' ? '✅' : v.status === 'skip' ? '⏭️' : '❌';
                            console.log(`  ${icon} ${n}: ${v.status}${v.bin ? ` → ${v.bin}` : ''}${v.reason || ''}`);
                        }
                        rl.prompt();
                    })
                    .catch(e => { console.log(`  ${c.red}${e.message}${c.reset}`); rl.prompt(); });
            } else {
                fetch(`${apiUrl}/api/mcp`)
                    .then(r => r.json())
                    .then(d => {
                        const names = Object.keys(d.servers || {});
                        console.log(`  ${c.cyan}MCP servers (${names.length}):${c.reset} ${names.join(', ') || '(none)'}`);
                        console.log(`  ${c.dim}/mcp sync    — 모든 CLI에 동기화${c.reset}`);
                        console.log(`  ${c.dim}/mcp install — 전역 설치 (npm i -g)${c.reset}`);
                        rl.prompt();
                    })
                    .catch(e => { console.log(`  ${c.red}${e.message}${c.reset}`); rl.prompt(); });
            }
            return;
        }
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
    console.log(`  ${c.dim}/quit to exit, /clear to reset, /file <path> to attach${c.reset}`);

    const footer = `  ${c.dim}${accent}${label}${c.reset}${c.dim}  |  /quit  |  /clear${c.reset}`;
    const promptPrefix = `  ${accent}\u276F${c.reset} `;

    // ─── Scroll region: fixed footer at bottom ──
    const getRows = () => process.stdout.rows || 24;

    function setupScrollRegion() {
        const rows = getRows();
        // Set scroll region to rows 1..(rows-2), leaving bottom 2 for footer
        process.stdout.write(`\x1b[1;${rows - 2}r`);
        // Draw fixed footer at absolute positions
        process.stdout.write(`\x1b[${rows - 1};1H\x1b[2K  ${c.dim}${hrLine()}${c.reset}`);
        process.stdout.write(`\x1b[${rows};1H\x1b[2K${footer}`);
        // Move cursor back into scroll region
        process.stdout.write(`\x1b[${rows - 2};1H`);
    }

    function cleanupScrollRegion() {
        const rows = getRows();
        // Reset scroll region to full terminal
        process.stdout.write(`\x1b[1;${rows}r`);
        process.stdout.write(`\x1b[${rows};1H\n`);
    }

    // Redraw footer on terminal resize
    process.stdout.on('resize', () => setupScrollRegion());

    function showPrompt() {
        prevLineCount = 1;  // reset for fresh prompt
        console.log('');
        console.log(`  ${c.dim}${hrLine()}${c.reset}`);
        process.stdout.write(promptPrefix);
    }

    // Phase 12.1.7: Calculate visual width (Korean/CJK = 2 columns, ANSI codes = 0)
    function visualWidth(str) {
        // Strip ANSI escape codes first
        const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
        let w = 0;
        for (const ch of stripped) {
            const cp = ch.codePointAt(0);
            // CJK ranges: Hangul, CJK Unified, Fullwidth, etc
            if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
                (cp >= 0x3040 && cp <= 0x33BF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
                (cp >= 0x4E00 && cp <= 0xA4CF) || (cp >= 0xA960 && cp <= 0xA97C) ||
                (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xD7B0 && cp <= 0xD7FF) ||
                (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE6F) ||
                (cp >= 0xFF01 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) ||
                (cp >= 0x20000 && cp <= 0x2FA1F)) {
                w += 2;
            } else {
                w += 1;
            }
        }
        return w;
    }

    let prevLineCount = 1;  // track how many terminal rows input occupied

    function redrawPromptLine() {
        const cols = process.stdout.columns || 80;
        // Move cursor up to the start of previous render, clear all lines
        if (prevLineCount > 1) {
            process.stdout.write(`\x1b[${prevLineCount - 1}A`);  // move up
        }
        for (let i = 0; i < prevLineCount; i++) {
            process.stdout.write('\r\x1b[2K');  // clear line
            if (i < prevLineCount - 1) process.stdout.write('\x1b[1B');  // move down
        }
        // Move back to top
        if (prevLineCount > 1) {
            process.stdout.write(`\x1b[${prevLineCount - 1}A`);
        }
        process.stdout.write('\r');

        // Write the prompt + input (handle embedded newlines)
        const lines = inputBuf.split('\n');
        const contPrefix = `  ${c.dim}· ${c.reset}`;  // continuation line prefix
        let totalRows = 0;
        for (let i = 0; i < lines.length; i++) {
            const prefix = i === 0 ? promptPrefix : contPrefix;
            const rendered = prefix + lines[i];
            process.stdout.write(rendered);
            if (i < lines.length - 1) process.stdout.write('\n');
            // Each line may wrap across multiple terminal rows
            totalRows += Math.max(1, Math.ceil(visualWidth(rendered) / cols));
        }
        prevLineCount = totalRows;
    }

    // ─── State ───────────────────────────────
    let inputBuf = '';
    let inputActive = true;
    let streaming = false;

    // ─── Raw stdin input ─────────────────────
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
        // ESC and Ctrl+C always work, even when agent is running
        // Typing always works (for queue). Only Enter submission checks inputActive.

        // Phase 12.1.7: Option+Enter (ESC+CR/LF) → insert newline
        if (key === '\x1b\r' || key === '\x1b\n') {
            inputBuf += '\n';
            redrawPromptLine();
            return;
        }

        if (key === '\r' || key === '\n') {
            // Backslash continuation: \ at end → newline instead of submit
            if (inputBuf.endsWith('\\')) {
                inputBuf = inputBuf.slice(0, -1) + '\n';
                redrawPromptLine();
                return;
            }
            // Enter — submit
            const text = inputBuf.trim();
            inputBuf = '';
            prevLineCount = 1;
            console.log('');  // newline after input

            if (!text) { showPrompt(); return; }
            if (text === '/quit' || text === '/exit' || text === '/q') {
                cleanupScrollRegion();
                console.log(`  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
                ws.close();
                process.stdin.setRawMode(false);
                process.exit(0);
            }
            if (text === '/clear') {
                console.clear();
                setupScrollRegion();
                showPrompt();
                return;
            }
            // Phase 10: /file command
            if (text.startsWith('/file ')) {
                const parts = text.slice(6).trim().split(/\s+/);
                const fp = resolvePath(parts[0]);
                const caption = parts.slice(1).join(' ');
                if (!fs.existsSync(fp)) {
                    console.log(`  ${c.red}파일 없음: ${fp}${c.reset}`);
                    showPrompt();
                    return;
                }
                const prompt = `[사용자가 파일을 보냈습니다: ${fp}]\n이 파일을 Read 도구로 읽고 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
                ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
                inputActive = false;
                return;
            }
            // Phase 12.1: /mcp command
            if (text === '/mcp' || text.startsWith('/mcp ')) {
                const sub = text.slice(4).trim();
                if (sub === 'sync') {
                    fetch(`${apiUrl}/api/mcp/sync`, { method: 'POST' })
                        .then(r => r.json())
                        .then(d => { console.log(`  ${c.green}MCP synced:${c.reset} ${JSON.stringify(d.results)}`); inputActive = true; showPrompt(); })
                        .catch(e => { console.log(`  ${c.red}${e.message}${c.reset}`); inputActive = true; showPrompt(); });
                } else if (sub === 'install') {
                    console.log(`  ${c.yellow}📦 Installing MCP servers globally...${c.reset}`);
                    fetch(`${apiUrl}/api/mcp/install`, { method: 'POST' })
                        .then(r => r.json())
                        .then(d => {
                            for (const [n, v] of Object.entries(d.results || {})) {
                                const icon = v.status === 'installed' ? '✅' : v.status === 'skip' ? '⏭️' : '❌';
                                console.log(`  ${icon} ${n}: ${v.status}${v.bin ? ` → ${v.bin}` : ''}${v.reason || ''}`);
                            }
                            inputActive = true; showPrompt();
                        })
                        .catch(e => { console.log(`  ${c.red}${e.message}${c.reset}`); inputActive = true; showPrompt(); });
                } else {
                    fetch(`${apiUrl}/api/mcp`)
                        .then(r => r.json())
                        .then(d => {
                            const names = Object.keys(d.servers || {});
                            console.log(`  ${c.cyan}MCP servers (${names.length}):${c.reset} ${names.join(', ') || '(none)'}`);
                            console.log(`  ${c.dim}/mcp sync    — 모든 CLI에 동기화${c.reset}`);
                            console.log(`  ${c.dim}/mcp install — 전역 설치 (npm i -g)${c.reset}`);
                            inputActive = true; showPrompt();
                        })
                        .catch(e => { console.log(`  ${c.red}${e.message}${c.reset}`); inputActive = true; showPrompt(); });
                }
                inputActive = false;
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
            // Ctrl+C — stop agent if running, otherwise exit
            if (!inputActive) {
                ws.send(JSON.stringify({ type: 'stop' }));
                console.log(`\n  ${c.yellow}■ stopped${c.reset}`);
                inputActive = true;
                showPrompt();
            } else {
                cleanupScrollRegion();
                console.log(`\n  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
                ws.close();
                process.stdin.setRawMode(false);
                process.exit(0);
            }
        } else if (key === '\x15') {
            // Ctrl+U — clear line
            inputBuf = '';
            redrawPromptLine();
        } else if (key === '\x1b') {
            // ESC — stop agent if running
            if (!inputActive) {
                ws.send(JSON.stringify({ type: 'stop' }));
                console.log(`\n  ${c.yellow}■ stopped${c.reset}`);
                inputActive = true;
                showPrompt();
            }
        } else if (key.charCodeAt(0) >= 32 || key.charCodeAt(0) > 127) {
            // Printable chars (including multibyte/Korean)
            // Phase 12.1.5: allow typing during agent run for queue
            if (!inputActive) {
                inputActive = true;
                showPrompt();  // new separator + prompt before queue input
            }
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
                    showPrompt();
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

                case 'agent_tool':
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (msg.icon && msg.label) {
                        process.stdout.write(`\r  ${c.dim}${msg.icon} ${msg.label}${c.reset}          \r`);
                    }
                    break;

                case 'queue_update':
                    if (msg.pending > 0) {
                        process.stdout.write(`\r  ${c.yellow}⏳ ${msg.pending}개 대기 중${c.reset}          \r`);
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
        cleanupScrollRegion();
        console.log(`\n  ${c.dim}Disconnected${c.reset}\n`);
        process.stdin.setRawMode(false);
        process.exit(0);
    });

    setupScrollRegion();
    showPrompt();
}
