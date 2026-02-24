/**
 * cli-claw chat — Phase 9.5
 * Three modes: default (raw stdin, persistent footer), --raw (JSON in UI), --simple (plain readline)
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, executeCommand, getCompletionItems, getArgumentCompletionItems } from '../../src/commands.js';

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
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const APP_VERSION = _require('../../package.json').version;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_SCRIPT = resolvePath(__dirname, 'skill.js');

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

const cliLabel = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode' };
const cliColor = { claude: c.magenta, codex: c.red, gemini: c.blue, opencode: c.yellow };
const accent = cliColor[info.cli] || c.red;
const label = cliLabel[info.cli] || info.cli;
const dir = info.workingDir.replace(process.env.HOME, '~');

// ─── Width helper ────────────────────────────
const W = () => Math.max(20, Math.min((process.stdout.columns || 60) - 4, 60));
const hrLine = () => '-'.repeat(W());

function renderCommandText(text) {
    return String(text || '').replace(/\n/g, '\n  ');
}

async function apiJson(path, init = {}, timeoutMs = 10000) {
    const headers = { ...(init.headers || {}) };
    const req = { ...init, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (req.body && typeof req.body !== 'string') {
        req.body = JSON.stringify(req.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(`${apiUrl}${path}`, req);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        const msg = data?.error || data?.message || `${resp.status} ${resp.statusText}`;
        throw new Error(msg);
    }
    return data;
}

function runSkillResetLocal() {
    const proc = spawnSync(
        process.execPath,
        [SKILL_SCRIPT, 'reset', '--force'],
        { encoding: 'utf8', timeout: 120000 }
    );
    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
        const msg = (proc.stderr || proc.stdout || `exit ${proc.status}`).trim();
        throw new Error(msg);
    }
}

function makeCliCommandCtx() {
    return {
        interface: 'cli',
        version: APP_VERSION,
        getSession: () => apiJson('/api/session'),
        getSettings: () => apiJson('/api/settings'),
        updateSettings: (patch) => apiJson('/api/settings', { method: 'PUT', body: patch }),
        getRuntime: () => apiJson('/api/runtime').catch(() => null),
        getSkills: () => apiJson('/api/skills').catch(() => []),
        clearSession: () => apiJson('/api/clear', { method: 'POST' }),
        getCliStatus: () => apiJson('/api/cli-status').catch(() => null),
        getMcp: () => apiJson('/api/mcp'),
        syncMcp: () => apiJson('/api/mcp/sync', { method: 'POST' }),
        installMcp: () => apiJson('/api/mcp/install', { method: 'POST' }, 120000),
        listMemory: () => apiJson('/api/claw-memory/list').then(d => d.files || []),
        searchMemory: (q) => apiJson(`/api/claw-memory/search?q=${encodeURIComponent(q)}`).then(d => d.result || '(no results)'),
        getBrowserStatus: () => apiJson('/api/browser/status'),
        getBrowserTabs: () => apiJson('/api/browser/tabs'),
        getPrompt: () => apiJson('/api/prompt'),
        resetSkills: async () => runSkillResetLocal(),
    };
}

// ─── Simple mode (plain readline, no tricks) ──
if (values.simple) {
    console.log(`\n  cli-claw v${APP_VERSION} · ${label} · :${values.port}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${label} > ` });
    let streaming = false;
    async function runSlashCommand(parsed) {
        try {
            const result = await executeCommand(parsed, makeCliCommandCtx());
            if (result?.code === 'clear_screen') console.clear();
            if (result?.text) console.log(`  ${renderCommandText(result.text)}`);
            if (result?.code === 'exit') {
                ws.close();
                rl.close();
                process.exit(0);
                return;
            }
        } catch (err) {
            console.log(`  ${c.red}${err.message}${c.reset}`);
        }
        rl.prompt();
    }
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
        const parsed = parseCommand(t);
        if (parsed) { void runSlashCommand(parsed); return; }
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
    console.log(`  ${c.bold}cli-claw${c.reset} ${c.dim}v${APP_VERSION}${c.reset}${isRaw ? `  ${c.dim}(raw json)${c.reset}` : ''}`);
    console.log('');
    console.log(`  ${c.dim}engine:${c.reset}    ${accent}${label}${c.reset}`);
    console.log(`  ${c.dim}directory:${c.reset}  ${c.cyan}${dir}${c.reset}`);
    console.log(`  ${c.dim}server:${c.reset}    ${c.green}\u25CF${c.reset} localhost:${values.port}`);
    console.log('');
    console.log(`  ${c.dim}/quit to exit, /clear to clear screen, /reset confirm to wipe${c.reset}`);
    console.log(`  ${c.dim}/file <path> to attach${c.reset}`);

    const footer = `  ${c.dim}${accent}${label}${c.reset}${c.dim}  |  /quit  |  /clear  |  /reset${c.reset}`;
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

    function showPrompt() {
        if (typeof closeAutocomplete === 'function') closeAutocomplete();
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

    function clipTextToCols(str, maxCols) {
        if (maxCols <= 0) return '';
        let out = '';
        let w = 0;
        for (const ch of str) {
            const cw = visualWidth(ch);
            if (w + cw > maxCols) break;
            out += ch;
            w += cw;
        }
        return out;
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
    let commandRunning = false;
    const ESC_WAIT_MS = 70;
    let escPending = false;
    let escTimer = null;
    const ac = {
        open: false,
        stage: 'command',
        contextHeader: '',
        items: [],
        selected: 0,
        windowStart: 0,
        visibleRows: 0,
        renderedRows: 0,
        maxRowsCommand: 6,
        maxRowsArgument: 8,
    };

    function getMaxPopupRows() {
        // Scroll region ends at rows-2 (rows-1/rows are fixed footer).
        // Prompt baseline at rows-2 can be lifted up to rows-3 lines.
        return Math.max(0, getRows() - 3);
    }

    function makeSelectionKey(item, stage) {
        if (!item) return '';
        const base = item.command ? `${item.command}:${item.name}` : item.name;
        return `${stage}:${base}`;
    }

    function popupTotalRows(state) {
        if (!state?.open) return 0;
        return (state.visibleRows || 0) + (state.contextHeader ? 1 : 0);
    }

    // ─ Phase 1c: use terminal natural scrolling to create space below ─
    // Prints \n within scroll region to push content up if needed,
    // then CSI A back to prompt row. No content is overwritten.
    function ensureSpaceBelow(n) {
        if (n <= 0) return;
        for (let i = 0; i < n; i++) process.stdout.write('\n');
        process.stdout.write(`\x1b[${n}A`);
    }

    function syncAutocompleteWindow() {
        if (!ac.items.length || ac.visibleRows <= 0) {
            ac.windowStart = 0;
            return;
        }
        ac.selected = Math.max(0, Math.min(ac.selected, ac.items.length - 1));
        const maxStart = Math.max(0, ac.items.length - ac.visibleRows);
        ac.windowStart = Math.max(0, Math.min(ac.windowStart, maxStart));
        if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
        if (ac.selected >= ac.windowStart + ac.visibleRows) {
            ac.windowStart = ac.selected - ac.visibleRows + 1;
        }
    }

    function resolveAutocompleteState(prevKey) {
        if (!inputBuf.startsWith('/') || inputBuf.includes('\n')) {
            return { open: false, items: [], selected: 0, visibleRows: 0 };
        }

        const body = inputBuf.slice(1);
        const firstSpace = body.indexOf(' ');
        let stage = 'command';
        let contextHeader = '';
        let items = [];

        if (firstSpace === -1) {
            items = getCompletionItems(inputBuf, 'cli');
        } else {
            const commandName = body.slice(0, firstSpace).trim().toLowerCase();
            if (!commandName) return { open: false, items: [], selected: 0, visibleRows: 0 };

            const rest = body.slice(firstSpace + 1);
            const endsWithSpace = /\s$/.test(rest);
            const tokens = rest.trim() ? rest.trim().split(/\s+/) : [];
            const partial = endsWithSpace ? '' : (tokens[tokens.length - 1] || '');
            const argv = endsWithSpace ? tokens : tokens.slice(0, -1);

            items = getArgumentCompletionItems(commandName, partial, 'cli', argv, {});
            if (items.length) {
                stage = 'argument';
                contextHeader = `${commandName} ▸ ${items[0].commandDesc || '인자 선택'}`;
            }
        }

        if (!items.length) {
            return { open: false, items: [], selected: 0, visibleRows: 0 };
        }

        const selected = (() => {
            if (!prevKey) return 0;
            const idx = items.findIndex(i => makeSelectionKey(i, stage) === prevKey);
            return idx >= 0 ? idx : 0;
        })();

        const maxRows = getMaxPopupRows();
        const headerRows = contextHeader ? 1 : 0;
        const maxItemRows = Math.max(0, maxRows - headerRows);
        const stageCap = stage === 'argument' ? ac.maxRowsArgument : ac.maxRowsCommand;
        const visibleRows = Math.min(stageCap, items.length, maxItemRows);
        if (visibleRows <= 0) {
            return { open: false, items: [], selected: 0, visibleRows: 0 };
        }
        return { open: true, stage, contextHeader, items, selected, visibleRows };
    }

    function clearAutocomplete() {
        if (ac.renderedRows <= 0) return;
        process.stdout.write('\x1b[s');
        for (let row = 1; row <= ac.renderedRows; row++) {
            process.stdout.write(`\x1b[${row}B\r\x1b[2K\x1b[${row}A`);
        }
        process.stdout.write('\x1b[u');
        ac.renderedRows = 0;
    }

    function closeAutocomplete() {
        clearAutocomplete();
        ac.open = false;
        ac.stage = 'command';
        ac.contextHeader = '';
        ac.items = [];
        ac.selected = 0;
        ac.windowStart = 0;
        ac.visibleRows = 0;
    }

    function formatAutocompleteLine(item, selected, stage) {
        const value = stage === 'argument' ? item.name : `/${item.name}`;
        const valueCol = stage === 'argument' ? 24 : 14;
        const valueText = value.length >= valueCol ? value.slice(0, valueCol) : value.padEnd(valueCol, ' ');
        const desc = item.desc || '';
        const raw = `  ${valueText}  ${desc}`;
        const line = clipTextToCols(raw, (process.stdout.columns || 80) - 2);
        return selected ? `\x1b[7m${line}${c.reset}` : `${c.dim}${line}${c.reset}`;
    }

    function renderAutocomplete() {
        clearAutocomplete();
        if (!ac.open || ac.items.length === 0 || ac.visibleRows <= 0) return;

        syncAutocompleteWindow();
        const start = ac.windowStart;
        const end = Math.min(ac.items.length, start + ac.visibleRows);
        const headerRows = ac.contextHeader ? 1 : 0;
        process.stdout.write('\x1b[s');

        if (headerRows) {
            process.stdout.write('\x1b[1B\r\x1b[2K');
            const header = clipTextToCols(`  ${ac.contextHeader}`, (process.stdout.columns || 80) - 2);
            process.stdout.write(`${c.dim}${header}${c.reset}`);
            process.stdout.write('\x1b[1A');
        }

        for (let i = start; i < end; i++) {
            const row = (i - start) + 1 + headerRows;
            process.stdout.write(`\x1b[${row}B\r\x1b[2K`);
            process.stdout.write(formatAutocompleteLine(ac.items[i], i === ac.selected, ac.stage));
            process.stdout.write(`\x1b[${row}A`);
        }
        ac.renderedRows = headerRows + (end - start);
        process.stdout.write('\x1b[u');
    }

    function redrawInputWithAutocomplete() {
        const prevItem = ac.items[ac.selected];
        const prevKey = makeSelectionKey(prevItem, ac.stage);
        const next = resolveAutocompleteState(prevKey);
        clearAutocomplete();
        // ─ Phase 1c: scroll to create space BELOW prompt (not above) ─
        if (next.open) ensureSpaceBelow(popupTotalRows(next));
        redrawPromptLine();
        if (!next.open) {
            ac.open = false;
            ac.stage = 'command';
            ac.contextHeader = '';
            ac.items = [];
            ac.selected = 0;
            ac.windowStart = 0;
            ac.visibleRows = 0;
            return;
        }
        ac.open = true;
        ac.stage = next.stage;
        ac.contextHeader = next.contextHeader || '';
        ac.items = next.items;
        ac.selected = next.selected;
        ac.visibleRows = next.visibleRows;
        syncAutocompleteWindow();
        renderAutocomplete();
    }

    function handleResize() {
        setupScrollRegion();
        if (!inputActive || commandRunning) return;
        redrawInputWithAutocomplete();
    }

    // Redraw footer + input/autocomplete on terminal resize (debounced)
    let resizeTimer = null;
    process.stdout.on('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { resizeTimer = null; handleResize(); }, 50);
    });

    async function runSlashCommand(parsed) {
        let exiting = false;
        try {
            const result = await executeCommand(parsed, makeCliCommandCtx());
            if (result?.code === 'clear_screen') {
                console.clear();
                setupScrollRegion();
            }
            if (result?.text) console.log(`  ${renderCommandText(result.text)}`);
            if (result?.code === 'exit') {
                exiting = true;
                cleanupScrollRegion();
                console.log(`  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
                ws.close();
                process.stdin.setRawMode(false);
                process.exit(0);
            }
        } catch (err) {
            console.log(`  ${c.red}${err.message}${c.reset}`);
        } finally {
            if (!exiting) {
                commandRunning = false;
                inputActive = true;
                closeAutocomplete();
                showPrompt();
            }
        }
    }

    // ─── Raw stdin input ─────────────────────
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function flushPendingEscape() {
        escPending = false;
        escTimer = null;
        if (ac.open) {
            closeAutocomplete();
            redrawPromptLine();
            return;
        }
        if (!inputActive) {
            if (commandRunning) return;
            ws.send(JSON.stringify({ type: 'stop' }));
            console.log(`\n  ${c.yellow}■ stopped${c.reset}`);
            inputActive = true;
            showPrompt();
        }
    }

    process.stdin.on('data', (key) => {
        if (escPending) {
            if (escTimer) clearTimeout(escTimer);
            escTimer = null;
            escPending = false;
            if (!key.startsWith('\x1b')) key = `\x1b${key}`;
        }

        // Delay ESC standalone handling to distinguish it from ESC sequences.
        if (key === '\x1b') {
            escPending = true;
            escTimer = setTimeout(flushPendingEscape, ESC_WAIT_MS);
            return;
        }

        // ESC and Ctrl+C always work, even when agent is running
        // Typing always works (for queue). Only Enter submission checks inputActive.

        // Phase 12.1.7: Option+Enter (ESC+CR/LF) → insert newline
        if (key === '\x1b\r' || key === '\x1b\n') {
            if (commandRunning) return;
            inputBuf += '\n';
            redrawInputWithAutocomplete();
            return;
        }

        // Autocomplete navigation (raw ESC sequences)
        const isUpKey = key === '\x1b[A' || key === '\x1bOA';
        const isDownKey = key === '\x1b[B' || key === '\x1bOB';
        const isPageUpKey = key === '\x1b[5~';
        const isPageDownKey = key === '\x1b[6~';
        const isHomeKey = key === '\x1b[H' || key === '\x1b[1~' || key === '\x1bOH';
        const isEndKey = key === '\x1b[F' || key === '\x1b[4~' || key === '\x1bOF';
        if (ac.open && isUpKey) { // Up
            ac.selected = Math.max(0, ac.selected - 1);
            if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
            renderAutocomplete();
            return;
        }
        if (ac.open && isDownKey) { // Down
            const maxIdx = ac.items.length - 1;
            ac.selected = Math.min(maxIdx, ac.selected + 1);
            if (ac.selected >= ac.windowStart + ac.visibleRows) {
                ac.windowStart = ac.selected - ac.visibleRows + 1;
            }
            renderAutocomplete();
            return;
        }
        if (ac.open && isPageUpKey) {
            const step = Math.max(1, ac.visibleRows);
            ac.selected = Math.max(0, ac.selected - step);
            if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
            renderAutocomplete();
            return;
        }
        if (ac.open && isPageDownKey) {
            const step = Math.max(1, ac.visibleRows);
            const maxIdx = ac.items.length - 1;
            ac.selected = Math.min(maxIdx, ac.selected + step);
            if (ac.selected >= ac.windowStart + ac.visibleRows) {
                ac.windowStart = ac.selected - ac.visibleRows + 1;
            }
            renderAutocomplete();
            return;
        }
        if (ac.open && isHomeKey) {
            ac.selected = 0;
            ac.windowStart = 0;
            renderAutocomplete();
            return;
        }
        if (ac.open && isEndKey) {
            ac.selected = Math.max(0, ac.items.length - 1);
            if (ac.selected >= ac.windowStart + ac.visibleRows) {
                ac.windowStart = ac.selected - ac.visibleRows + 1;
            }
            renderAutocomplete();
            return;
        }
        if (ac.open && key === '\t') { // Tab accept (no execute)
            const picked = ac.items[ac.selected];
            const pickedStage = ac.stage;
            if (picked) {
                if (pickedStage === 'argument') {
                    inputBuf = picked.insertText || `/${picked.command || ''} ${picked.name}`.trim();
                } else {
                    inputBuf = `/${picked.name}${picked.args ? ' ' : ''}`;
                }
                closeAutocomplete();
                redrawPromptLine();
            }
            return;
        }
        if (key === '\r' || key === '\n') {
            if (ac.open) {
                const picked = ac.items[ac.selected];
                const pickedStage = ac.stage;
                closeAutocomplete();
                if (picked) {
                    if (pickedStage === 'argument') {
                        inputBuf = picked.insertText || `/${picked.command || ''} ${picked.name}`.trim();
                        redrawPromptLine();
                        return;
                    }
                    if (picked.args) {
                        inputBuf = `/${picked.name} `;
                        redrawPromptLine();
                        return;
                    }
                    inputBuf = `/${picked.name}`;
                }
            }
            // Backslash continuation: \ at end → newline instead of submit
            if (inputBuf.endsWith('\\')) {
                inputBuf = inputBuf.slice(0, -1) + '\n';
                redrawInputWithAutocomplete();
                return;
            }
            // Enter — submit
            const text = inputBuf.trim();
            inputBuf = '';
            closeAutocomplete();
            prevLineCount = 1;
            console.log('');  // newline after input

            if (!text) { showPrompt(); return; }
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
            const parsed = parseCommand(text);
            if (parsed) {
                inputActive = false;
                commandRunning = true;
                void runSlashCommand(parsed);
                return;
            }
            ws.send(JSON.stringify({ type: 'send_message', text }));
            inputActive = false;
        } else if (key === '\x7f' || key === '\b') {
            // Backspace
            if (inputBuf.length > 0) {
                inputBuf = inputBuf.slice(0, -1);
                redrawInputWithAutocomplete();
            }
        } else if (key === '\x03') {
            // Ctrl+C — stop agent if running, otherwise exit
            if (!inputActive) {
                if (commandRunning) return;
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
            redrawInputWithAutocomplete();
        } else if (key.charCodeAt(0) >= 32 || key.charCodeAt(0) > 127) {
            // Printable chars (including multibyte/Korean)
            // Phase 12.1.5: allow typing during agent run for queue
            if (!inputActive) {
                if (commandRunning) return;
                inputActive = true;
                showPrompt();  // new separator + prompt before queue input
            }
            inputBuf += key;
            redrawInputWithAutocomplete();
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
