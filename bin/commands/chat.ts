/**
 * cli-jaw chat — Phase 9.5
 * Three modes: default (raw stdin, persistent footer), --raw (JSON in UI), --simple (plain readline)
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand, executeCommand, getCompletionItems, getArgumentCompletionItems } from '../../src/cli/commands.js';
import {
    appendNewlineToComposer,
    appendTextToComposer,
    backspaceComposer,
    clearComposer,
    consumePasteProtocol,
    flattenComposerForSubmit,
    getComposerDisplayText,
    getPlainCommandDraft,
    getTrailingTextSegment,
    setBracketedPaste,
    type PasteCollapseConfig,
} from '../../src/cli/tui/composer.js';
import { classifyKeyAction } from '../../src/cli/tui/keymap.js';
import {
    applyResolvedAutocompleteState,
    clearAutocomplete,
    closeAutocomplete,
    makeSelectionKey,
    popupTotalRows,
    renderAutocomplete,
    resolveAutocompleteState,
    syncAutocompleteWindow,
    renderHelpOverlay,
    clearOverlayBox,
    renderCommandPalette,
} from '../../src/cli/tui/overlay.js';
import { clipTextToCols, visualWidth } from '../../src/cli/tui/renderers.js';
import { cleanupScrollRegion, ensureSpaceBelow, resolveShellLayout, setupScrollRegion } from '../../src/cli/tui/shell.js';
import { createTuiStore } from '../../src/cli/tui/store.js';
import {
    appendUserItem, startAssistantItem, appendToActiveAssistant,
    finalizeAssistant, appendStatusItem, clearEphemeralStatus,
} from '../../src/cli/tui/transcript.js';
import {
    isGitRepo, captureFileSet, diffFileSets,
    detectIde, getIdeCli, openDiffInIde, getDiffStat,
} from '../../src/ide/diff.js';

const chatCwd = process.cwd();
const isGit = isGitRepo(chatCwd);
const detectedIde = detectIde();
let ideEnabled = isGit;
let idePopEnabled = false;
const preFileSetQueue: Map<string, string>[] = [];

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
const wsUrl = getWsUrl(values.port as string);
const apiUrl = getServerUrl(values.port as string);
import { APP_VERSION, getServerUrl, getWsUrl } from '../../src/core/config.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILL_SCRIPT = resolvePath(__dirname, 'skill.js');

let ws: any;
try {
    ws = await new Promise((resolve, reject) => {
        const s = new WebSocket(wsUrl);
        s.on('open', () => resolve(s));
        s.on('error', reject);
    });
} catch {
    console.error(`\n  ${c.red}x${c.reset} Cannot connect to ${wsUrl}`);
    console.error(`  Run ${c.cyan}cli-jaw serve${c.reset} first\n`);
    process.exit(1);
}

// ─── Fetch info ──────────────────────────────
let info = { cli: 'codex', workingDir: '~', model: '' };
let tuiConfig = { pasteCollapseLines: 2, pasteCollapseChars: 160, keymapPreset: 'default', diffStyle: 'summary', themeSeed: 'jaw-default' };
try {
    const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
        const res = await r.json() as Record<string, any>;
        const s = res.data || res;
        const cli = s.cli || 'codex';
        info = { cli, workingDir: s.workingDir || '~', model: s.perCli?.[cli]?.model || '' };
        if (s.tui && typeof s.tui === 'object') tuiConfig = { ...tuiConfig, ...s.tui };
    }
    // Active session model overrides perCli default
    const sr = await fetch(`${apiUrl}/api/session`, { signal: AbortSignal.timeout(2000) });
    if (sr.ok) {
        const ses = await sr.json() as Record<string, any>;
        const sd = ses.data || ses;
        if (sd.model) info.model = sd.model;
    }
} catch { }

const cliLabel: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', copilot: 'Copilot' };
const cliColor: Record<string, string> = { claude: c.magenta, codex: c.red, gemini: c.blue, opencode: c.yellow, copilot: c.cyan };
const accent = cliColor[info.cli] || c.red;
const label = cliLabel[info.cli] || info.cli;
const dir = info.workingDir.replace(process.env.HOME || '', '~');

// ─── Width helper ────────────────────────────
const W = () => Math.max(20, Math.min((process.stdout.columns || 60) - 4, 60));
const hrLine = () => '-'.repeat(W());

function renderCommandText(text: string) {
    return String(text || '').replace(/\n/g, '\n  ');
}

async function apiJson(path: string, init: Record<string, any> = {}, timeoutMs = 10000) {
    const headers: Record<string, string> = { ...(init.headers || {}) };
    const req: Record<string, any> = { ...init, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (req.body && typeof req.body !== 'string') {
        req.body = JSON.stringify(req.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(`${apiUrl}${path}`, req);
    const data = await resp.json().catch(() => ({})) as Record<string, any>;
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
        updateSettings: (patch: any) => apiJson('/api/settings', { method: 'PUT', body: patch }),
        getRuntime: () => apiJson('/api/runtime').catch(() => null),
        getSkills: () => apiJson('/api/skills').catch(() => []),
        clearSession: () => apiJson('/api/clear', { method: 'POST' }),
        getCliStatus: () => apiJson('/api/cli-status').catch(() => null),
        getMcp: () => apiJson('/api/mcp'),
        syncMcp: () => apiJson('/api/mcp/sync', { method: 'POST' }),
        installMcp: () => apiJson('/api/mcp/install', { method: 'POST' }, 120000),
        listMemory: () => apiJson('/api/jaw-memory/list').then((d: any) => d.files || []),
        searchMemory: (q: string) => apiJson(`/api/jaw-memory/search?q=${encodeURIComponent(q)}`).then((d: any) => d.result || '(no results)'),
        getBrowserStatus: () => apiJson('/api/browser/status'),
        getBrowserTabs: () => apiJson('/api/browser/tabs'),
        resetEmployees: () => apiJson('/api/employees/reset', { method: 'POST' }),
        getPrompt: () => apiJson('/api/prompt'),
        resetSkills: () => apiJson('/api/skills/reset', { method: 'POST' }).catch(() => { }),
    };
}

// ─── Simple mode (plain readline, no tricks) ──
if (values.simple) {
    console.log(`\n  cli-jaw v${APP_VERSION} · ${label} · :${values.port}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${label} > ` });
    let streaming = false;
    async function runSlashCommand(parsed: any) {
        try {
            const result = await executeCommand(parsed, makeCliCommandCtx());
            if (result?.code === 'clear_screen') console.clear();
            if (result?.text) console.log(`  ${renderCommandText(result.text)}`);
            // IDE command state handling (mirror of default mode)
            if (result?.code === 'ide_toggle') { ideEnabled = !ideEnabled; }
            if (result?.code === 'ide_on') { ideEnabled = true; }
            if (result?.code === 'ide_off') { ideEnabled = false; }
            if (['ide_toggle', 'ide_on', 'ide_off'].includes(result?.code)) {
                console.log(`  ${ideEnabled ? '\u2713' : '\u2717'} IDE diff: ${ideEnabled ? 'ON' : 'OFF'}${isGit ? '' : ' (non-git)'}`);
            }
            if (result?.code === 'ide_pop_toggle') {
                idePopEnabled = !idePopEnabled;
                const ideName = detectedIde ? getIdeCli(detectedIde) : null;
                console.log(`  ${idePopEnabled ? '\u2713' : '\u2717'} IDE popup: ${idePopEnabled ? 'ON' : 'OFF'}${ideName ? ` (${ideName})` : ' (IDE \ubbf8\uac10\uc9c0)'}`);
            }
            if (result?.code === 'exit') {
                ws.close();
                rl.close();
                process.exit(0);
                return;
            }
        } catch (err) {
            console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
        }
        rl.prompt();
    }
    ws.on('message', (data: any) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'agent_chunk') { if (!streaming) streaming = true; process.stdout.write(msg.text || ''); }
            else if (msg.type === 'agent_fallback') {
                console.log(`  ⚡ ${msg.from} 실패 → ${msg.to}로 재시도`);
            }
            else if (msg.type === 'agent_done') {
                if (streaming) { process.stdout.write('\n\n'); streaming = false; }
                else if (msg.text) console.log(msg.text + '\n');
                // IDE diff: simple mode (queue drain unconditional)
                if (isGit && preFileSetQueue.length > 0) {
                    const preSet = preFileSetQueue.shift()!;
                    if (ideEnabled) {
                        const postSet = captureFileSet(chatCwd);
                        const changed = diffFileSets(preSet, postSet);
                        if (changed.length > 0) {
                            console.log(`  \u{1F4C2} ${changed.length}개 파일 변경됨`);
                            for (const f of changed.slice(0, 10)) console.log(`    ◦ ${f}`);
                            if (idePopEnabled && detectedIde) openDiffInIde(chatCwd, changed, detectedIde);
                        }
                    }
                }
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
            const fp = resolvePath(parts[0]!);
            const caption = parts.slice(1).join(' ');
            if (!fs.existsSync(fp)) { console.log(`  ${c.red}파일 없음: ${fp}${c.reset}`); rl.prompt(); return; }
            const prompt = `[사용자가 파일을 보냈습니다: ${fp}]\n이 파일을 Read 도구로 읽고 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
            // IDE: pre-snapshot before send (simple mode)
            if (ideEnabled && isGit) {
                preFileSetQueue.push(captureFileSet(chatCwd));
            }
            ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
            return;
        }
        const parsed = parseCommand(t);
        if (parsed) { void runSlashCommand(parsed); return; }
        // IDE: pre-snapshot before send (simple mode)
        if (ideEnabled && isGit) {
            preFileSetQueue.push(captureFileSet(chatCwd));
        }
        ws.send(JSON.stringify({ type: 'send_message', text: t }));
    });
    rl.on('close', () => { ws.close(); process.exit(0); });
    ws.on('close', () => { console.log('Disconnected'); process.exit(0); });
    rl.prompt();

} else {
    // ─── Default + Raw — shared UI with raw stdin ──
    const isRaw = values.raw;

    // Banner — block art (no border frame)
    const modelStr = info.model ? `${c.dim}model:${c.reset}     ${c.bold}${info.model}${c.reset}` : '';
    // prettier-ignore
    const art = [
        '██████╗ ██╗     ██╗     ██╗ █████╗ ██╗    ██╗',
        '██╔════╝██║     ██║     ██║██╔══██╗██║    ██║',
        '██║     ██║     ██║     ██║███████║██║ █╗ ██║',
        '██║     ██║     ██║██   ██║██╔══██║██║███╗██║',
        '╚██████╗███████╗██║╚█████╔╝██║  ██║╚███╔███╔╝',
        ' ╚═════╝╚══════╝╚═╝ ╚════╝ ╚═╝  ╚═╝ ╚══╝╚══╝',
    ];
    console.log('');
    for (const line of art) console.log(`  ${c.cyan}${c.bold}${line}${c.reset}`);
    console.log(`  ${c.dim}v${APP_VERSION}${c.reset}${isRaw ? `  ${c.dim}(raw json)${c.reset}` : ''}`);
    console.log('');
    console.log(`  ${c.dim}engine:${c.reset}    ${accent}${label}${c.reset}`);
    if (modelStr) console.log(`  ${modelStr}`);
    console.log(`  ${c.dim}directory:${c.reset}  ${c.cyan}${dir}${c.reset}`);
    console.log(`  ${c.dim}server:${c.reset}    ${c.green}\u25CF${c.reset} localhost:${values.port}`);
    if (ideEnabled) {
        const ideName = detectedIde || 'terminal';
        console.log(`  ${c.dim}ide diff:${c.reset}  ${c.green}\u25CF${c.reset} ON (${ideName}, git)`);
    } else if (!isGit) {
        console.log(`  ${c.dim}ide diff:${c.reset}  ${c.yellow}\u25CB${c.reset} OFF (non-git)`);
    }
    console.log('');
    console.log(`  ${c.dim}/quit to exit, /clear to clear screen, /reset confirm to factory reset${c.reset}`);
    console.log(`  ${c.dim}/file <path> to attach${c.reset}`);

    const footer = `  ${c.dim}${accent}${label}${c.reset}${c.dim}  |  /quit  |  /clear${c.reset}`;
    const promptPrefix = `  ${accent}\u276F${c.reset} `;

    // ─── Scroll region: fixed footer at bottom ──
    const getRows = () => process.stdout.rows || 24;

    function renderBlockSeparator() {
        process.stdout.write('\n');
        console.log(`  ${c.dim}${hrLine()}${c.reset}`);
    }

    function renderAssistantTurnStart() {
        process.stdout.write('\n  ');
    }

    function showPrompt() {
        if (typeof closeAutocomplete === 'function') closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
        prevLineCount = 1;  // reset for fresh prompt
        process.stdout.write(promptPrefix);
    }

    function openPromptBlock() {
        renderBlockSeparator();
        showPrompt();
    }

    function reopenPromptLine() {
        process.stdout.write('\n');
        showPrompt();
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
        const lines = getComposerDisplayText(composer).split('\n');
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
    const store = createTuiStore();
    const composer = store.composer;
    const pasteCapture = store.pasteCapture;
    const panes = store.panes;
    const transcript = store.transcript;
    const ov = store.overlay;
    let overlayBoxHeight = 0;
    let inputActive = true;
    let streaming = false;
    let commandRunning = false;
    const ESC_WAIT_MS = 70;
    let escPending = false;
    let escTimer: ReturnType<typeof setTimeout> | null = null;
    const ac = store.autocomplete;

    function dismissOverlay() {
        if (!ov.helpOpen && !ov.paletteOpen) return;
        if (overlayBoxHeight > 0) {
            clearOverlayBox(
                (chunk) => process.stdout.write(chunk),
                process.stdout.columns || 80,
                getRows(),
                overlayBoxHeight,
            );
            overlayBoxHeight = 0;
        }
        ov.helpOpen = false;
        ov.paletteOpen = false;
        ov.paletteFilter = '';
        ov.paletteSelected = 0;
        ov.paletteItems = [];
        setupScrollRegion(
            footer,
            `  ${c.dim}${hrLine()}${c.reset}`,
            resolveShellLayout(process.stdout.columns || 80, getRows(), panes),
        );
        showPrompt();
        redrawPromptLine();
    }

    function getMaxPopupRows() {
        // Scroll region ends at rows-2 (rows-1/rows are fixed footer).
        // Prompt baseline at rows-2 can be lifted up to rows-3 lines.
        return Math.max(0, getRows() - 3);
    }

    function redrawInputWithAutocomplete() {
        const prevItem = ac.items[ac.selected];
        const prevKey = makeSelectionKey(prevItem, ac.stage);
        const next = resolveAutocompleteState({
            draft: getPlainCommandDraft(composer),
            prevKey,
            maxPopupRows: getMaxPopupRows(),
            maxRowsCommand: ac.maxRowsCommand,
            maxRowsArgument: ac.maxRowsArgument,
        });
        clearAutocomplete(ac, (chunk) => process.stdout.write(chunk));
        // ─ Phase 1c: scroll to create space BELOW prompt (not above) ─
        if (next.open) ensureSpaceBelow(popupTotalRows(next));
        redrawPromptLine();
        applyResolvedAutocompleteState(ac, next);
        renderAutocomplete(ac, {
            write: (chunk) => process.stdout.write(chunk),
            columns: process.stdout.columns || 80,
            dimCode: c.dim,
            resetCode: c.reset,
            clipTextToCols,
        });
    }

    function handleResize() {
        setupScrollRegion(footer, `  ${c.dim}${hrLine()}${c.reset}`, resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
        if (!inputActive || commandRunning) return;
        redrawInputWithAutocomplete();
    }

    // Redraw footer + input/autocomplete on terminal resize (debounced)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    process.stdout.on('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { resizeTimer = null; handleResize(); }, 50);
    });

    async function runSlashCommand(parsed: any) {
        // Overlay intercepts — handle before executeCommand
        if (parsed.name === 'help') {
            ov.helpOpen = true;
            const cmds = getCompletionItems('/', 'cli');
            overlayBoxHeight = renderHelpOverlay(
                (chunk) => process.stdout.write(chunk),
                process.stdout.columns || 80,
                getRows(),
                c.dim, c.reset,
                cmds,
            );
            commandRunning = false;
            inputActive = true;
            return;
        }
        if (parsed.name === 'commands') {
            ov.paletteOpen = true;
            ov.paletteFilter = '';
            ov.paletteSelected = 0;
            ov.paletteItems = getCompletionItems('/', 'cli');
            overlayBoxHeight = renderCommandPalette({
                write: (chunk) => process.stdout.write(chunk),
                cols: process.stdout.columns || 80,
                rows: getRows(),
                dimCode: c.dim,
                resetCode: c.reset,
                filter: ov.paletteFilter,
                items: ov.paletteItems,
                selected: ov.paletteSelected,
            });
            commandRunning = false;
            inputActive = true;
            return;
        }
        let exiting = false;
        try {
            const result = await executeCommand(parsed, makeCliCommandCtx());
            if (result?.code === 'clear_screen') {
                console.clear();
                setupScrollRegion(footer, `  ${c.dim}${hrLine()}${c.reset}`, resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
            }
            if (result?.text) console.log(`  ${renderCommandText(result.text)}`);
            // IDE command result handling
            if (result?.code === 'ide_toggle') { ideEnabled = !ideEnabled; }
            if (result?.code === 'ide_on') { ideEnabled = true; }
            if (result?.code === 'ide_off') { ideEnabled = false; }
            if (['ide_toggle', 'ide_on', 'ide_off'].includes(result?.code)) {
                console.log(`  ${ideEnabled ? c.green + '✓' : c.yellow + '✗'}${c.reset} IDE diff: ${ideEnabled ? 'ON' : 'OFF'}${isGit ? '' : ` ${c.dim}(non-git)${c.reset}`}`);
            }
            if (result?.code === 'ide_pop_toggle') {
                idePopEnabled = !idePopEnabled;
                const ideName = detectedIde ? getIdeCli(detectedIde) : null;
                console.log(`  ${idePopEnabled ? c.green + '✓' : c.yellow + '✗'}${c.reset} IDE popup: ${idePopEnabled ? 'ON' : 'OFF'}${ideName ? ` (${ideName})` : ` ${c.dim}(IDE 미감지)${c.reset}`}`);
            }
            if (result?.code === 'exit') {
                exiting = true;
                cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
                console.log(`  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
                setBracketedPaste(false);
                ws.close();
                process.stdin.setRawMode(false);
                process.exit(0);
            }
        } catch (err) {
            console.log(`  ${c.red}${(err as Error).message}${c.reset}`);
        } finally {
            if (!exiting) {
                commandRunning = false;
                inputActive = true;
                closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
                openPromptBlock();
            }
        }
    }

    // ─── Raw stdin input ─────────────────────
    process.stdin.setRawMode(true);
    setBracketedPaste(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function flushPendingEscape() {
        escPending = false;
        escTimer = null;
        if (ov.helpOpen || ov.paletteOpen) {
            dismissOverlay();
            return;
        }
        if (ac.open) {
            closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
            redrawPromptLine();
            return;
        }
        if (!inputActive) {
            if (commandRunning) return;
            ws.send(JSON.stringify({ type: 'stop' }));
            console.log(`\n  ${c.yellow}■ stopped${c.reset}`);
            inputActive = true;
            openPromptBlock();
        }
    }

    function handleKeyInput(rawKey: string) {
        let key = rawKey;
        if (escPending) {
            if (escTimer) clearTimeout(escTimer);
            escTimer = null;
            escPending = false;
            if (!key.startsWith('\x1b')) key = `\x1b${key}`;
        }

        // Delay ESC standalone handling to distinguish it from ESC sequences.
        const action = classifyKeyAction(key);
        if (action === 'escape-alone') {
            escPending = true;
            escTimer = setTimeout(flushPendingEscape, ESC_WAIT_MS);
            return;
        }

        // ESC and Ctrl+C always work, even when agent is running
        // Typing always works (for queue). Only Enter submission checks inputActive.

        // Phase 12.1.7: Option+Enter (ESC+CR/LF) → insert newline
        if (action === 'option-enter') {
            if (commandRunning) return;
            if (!inputActive) {
                inputActive = true;
                openPromptBlock();
            }
            appendNewlineToComposer(composer);
            redrawInputWithAutocomplete();
            return;
        }

        // Help overlay: ? when input is empty
        if (action === 'printable' && key === '?' && !ac.open && !ov.paletteOpen) {
            const draft = getPlainCommandDraft(composer);
            if (draft === '' || draft === null) {
                if (ov.helpOpen) {
                    dismissOverlay();
                    return;
                }
                ov.helpOpen = true;
                closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
                const cmds = getCompletionItems('/', 'cli');
                overlayBoxHeight = renderHelpOverlay(
                    (chunk) => process.stdout.write(chunk),
                    process.stdout.columns || 80,
                    getRows(),
                    c.dim,
                    c.reset,
                    cmds,
                );
                return;
            }
        }

        // Dismiss help on any key that isn't ?
        // (ESC is handled by flushPendingEscape which calls dismissOverlay)
        if (ov.helpOpen) {
            dismissOverlay();
        }

        // Command palette: Ctrl+K
        if (action === 'ctrl-k' && !ov.helpOpen) {
            if (ov.paletteOpen) {
                dismissOverlay();
                return;
            }
            ov.paletteOpen = true;
            ov.paletteFilter = '';
            ov.paletteSelected = 0;
            ov.paletteItems = getCompletionItems('/', 'cli');
            closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
            overlayBoxHeight = renderCommandPalette({
                write: (chunk) => process.stdout.write(chunk),
                cols: process.stdout.columns || 80,
                rows: getRows(),
                dimCode: c.dim,
                resetCode: c.reset,
                filter: ov.paletteFilter,
                items: ov.paletteItems,
                selected: ov.paletteSelected,
            });
            return;
        }

        // Palette input handling
        if (ov.paletteOpen) {
            if (action === 'escape-alone') {
                dismissOverlay();
                return;
            }
            if (action === 'arrow-up') {
                ov.paletteSelected = Math.max(0, ov.paletteSelected - 1);
            } else if (action === 'arrow-down') {
                ov.paletteSelected = Math.min(ov.paletteItems.length - 1, ov.paletteSelected + 1);
            } else if (action === 'enter') {
                const picked = ov.paletteItems[ov.paletteSelected];
                dismissOverlay();
                if (picked) {
                    clearComposer(composer);
                    appendTextToComposer(composer, `/${picked.name}`);
                    handleKeyInput('\r');
                }
                return;
            } else if (action === 'backspace') {
                ov.paletteFilter = ov.paletteFilter.slice(0, -1);
                ov.paletteItems = getCompletionItems('/' + ov.paletteFilter, 'cli');
                ov.paletteSelected = Math.min(ov.paletteSelected, Math.max(0, ov.paletteItems.length - 1));
            } else if (action === 'printable') {
                ov.paletteFilter += key;
                ov.paletteItems = getCompletionItems('/' + ov.paletteFilter, 'cli');
                ov.paletteSelected = Math.min(ov.paletteSelected, Math.max(0, ov.paletteItems.length - 1));
            } else {
                return;
            }
            overlayBoxHeight = renderCommandPalette({
                write: (chunk) => process.stdout.write(chunk),
                cols: process.stdout.columns || 80,
                rows: getRows(),
                dimCode: c.dim,
                resetCode: c.reset,
                filter: ov.paletteFilter,
                items: ov.paletteItems,
                selected: ov.paletteSelected,
            });
            return;
        }

        // Autocomplete navigation (raw ESC sequences)
        if (ac.open && action === 'arrow-up') { // Up
            ac.selected = Math.max(0, ac.selected - 1);
            if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
            renderAutocomplete(ac, {
                write: (chunk) => process.stdout.write(chunk),
                columns: process.stdout.columns || 80,
                dimCode: c.dim,
                resetCode: c.reset,
                clipTextToCols,
            });
            return;
        }
        if (ac.open && action === 'arrow-down') { // Down
            const maxIdx = ac.items.length - 1;
            ac.selected = Math.min(maxIdx, ac.selected + 1);
            if (ac.selected >= ac.windowStart + ac.visibleRows) {
                ac.windowStart = ac.selected - ac.visibleRows + 1;
            }
            renderAutocomplete(ac, {
                write: (chunk) => process.stdout.write(chunk),
                columns: process.stdout.columns || 80,
                dimCode: c.dim,
                resetCode: c.reset,
                clipTextToCols,
            });
            return;
        }
        if (ac.open && action === 'page-up') {
            const step = Math.max(1, ac.visibleRows);
            ac.selected = Math.max(0, ac.selected - step);
            if (ac.selected < ac.windowStart) ac.windowStart = ac.selected;
            renderAutocomplete(ac, {
                write: (chunk) => process.stdout.write(chunk),
                columns: process.stdout.columns || 80,
                dimCode: c.dim,
                resetCode: c.reset,
                clipTextToCols,
            });
            return;
        }
        if (ac.open && action === 'page-down') {
            const step = Math.max(1, ac.visibleRows);
            const maxIdx = ac.items.length - 1;
            ac.selected = Math.min(maxIdx, ac.selected + step);
            if (ac.selected >= ac.windowStart + ac.visibleRows) {
                ac.windowStart = ac.selected - ac.visibleRows + 1;
            }
            renderAutocomplete(ac, {
                write: (chunk) => process.stdout.write(chunk),
                columns: process.stdout.columns || 80,
                dimCode: c.dim,
                resetCode: c.reset,
                clipTextToCols,
            });
            return;
        }
        if (ac.open && action === 'home') {
            ac.selected = 0;
            ac.windowStart = 0;
            renderAutocomplete(ac, {
                write: (chunk) => process.stdout.write(chunk),
                columns: process.stdout.columns || 80,
                dimCode: c.dim,
                resetCode: c.reset,
                clipTextToCols,
            });
            return;
        }
        if (ac.open && action === 'end') {
            ac.selected = Math.max(0, ac.items.length - 1);
            if (ac.selected >= ac.windowStart + ac.visibleRows) {
                ac.windowStart = ac.selected - ac.visibleRows + 1;
            }
            renderAutocomplete(ac, {
                write: (chunk) => process.stdout.write(chunk),
                columns: process.stdout.columns || 80,
                dimCode: c.dim,
                resetCode: c.reset,
                clipTextToCols,
            });
            return;
        }
        if (ac.open && action === 'tab') { // Tab accept (no execute)
            const picked = ac.items[ac.selected];
            const pickedStage = ac.stage;
            if (picked) {
                clearComposer(composer);
                if (pickedStage === 'argument') {
                    appendTextToComposer(composer, picked.insertText || `/${picked.command || ''} ${picked.name}`.trim());
                } else {
                    appendTextToComposer(composer, `/${picked.name}${picked.args ? ' ' : ''}`);
                }
                closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
                redrawPromptLine();
            }
            return;
        }
        if (action === 'enter') {
            if (ac.open) {
                const picked = ac.items[ac.selected];
                const pickedStage = ac.stage;
                closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
                if (picked) {
                    clearComposer(composer);
                    if (pickedStage === 'argument') {
                        appendTextToComposer(composer, picked.insertText || `/${picked.command || ''} ${picked.name}`.trim());
                        redrawPromptLine();
                        return;
                    }
                    if (picked.args) {
                        appendTextToComposer(composer, `/${picked.name} `);
                        redrawPromptLine();
                        return;
                    }
                    appendTextToComposer(composer, `/${picked.name}`);
                }
            }
            // Backslash continuation: \ at end → newline instead of submit
            const trailing = getTrailingTextSegment(composer);
            if (trailing.text.endsWith('\\')) {
                trailing.text = trailing.text.slice(0, -1);
                appendNewlineToComposer(composer);
                redrawInputWithAutocomplete();
                return;
            }
            // Enter — submit
            const draft = getPlainCommandDraft(composer);
            const displayText = getComposerDisplayText(composer);
            const text = flattenComposerForSubmit(composer).trim();
            clearComposer(composer);
            closeAutocomplete(ac, (chunk) => process.stdout.write(chunk));
            prevLineCount = 1;

            if (!text) { reopenPromptLine(); return; }
            renderBlockSeparator();
            appendUserItem(transcript, displayText.trim(), text);
            // Phase 10: /file command
            if (draft !== null && text.startsWith('/file ')) {
                const parts = text.slice(6).trim().split(/\s+/);
                const fp = resolvePath(parts[0]!);
                const caption = parts.slice(1).join(' ');
                if (!fs.existsSync(fp)) {
                    console.log(`  ${c.red}파일 없음: ${fp}${c.reset}`);
                    openPromptBlock();
                    return;
                }
                const prompt = `[사용자가 파일을 보냈습니다: ${fp}]\n이 파일을 Read 도구로 읽고 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
                // IDE: pre-snapshot before send (queue push)
                if (ideEnabled && isGit) {
                    preFileSetQueue.push(captureFileSet(chatCwd));
                }
                ws.send(JSON.stringify({ type: 'send_message', text: prompt }));
                inputActive = false;
                return;
            }
            const parsed = draft !== null ? parseCommand(text) : null;
            if (parsed) {
                inputActive = false;
                commandRunning = true;
                void runSlashCommand(parsed);
                return;
            }
            // IDE: pre-snapshot before send (queue push)
            if (ideEnabled && isGit) {
                preFileSetQueue.push(captureFileSet(chatCwd));
            }
            ws.send(JSON.stringify({ type: 'send_message', text }));
            inputActive = false;
        } else if (action === 'backspace') {
            // Backspace
            backspaceComposer(composer);
            redrawInputWithAutocomplete();
        } else if (action === 'ctrl-c') {
            // Ctrl+C — stop agent if running, otherwise exit
            if (!inputActive) {
                if (commandRunning) return;
                ws.send(JSON.stringify({ type: 'stop' }));
                console.log(`\n  ${c.yellow}■ stopped${c.reset}`);
                inputActive = true;
                openPromptBlock();
            } else {
                cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
                console.log(`\n  ${c.dim}Bye! \uD83E\uDD9E${c.reset}\n`);
                setBracketedPaste(false);
                ws.close();
                process.stdin.setRawMode(false);
                process.exit(0);
            }
        } else if (action === 'ctrl-u') {
            // Ctrl+U — clear line
            clearComposer(composer);
            redrawInputWithAutocomplete();
        } else if (action === 'printable') {
            // Printable chars (including multibyte/Korean)
            // Phase 12.1.5: allow typing during agent run for queue
            if (!inputActive) {
                if (commandRunning) return;
                inputActive = true;
                openPromptBlock();  // new separator + prompt before queue input
            }
            appendTextToComposer(composer, key);
            redrawInputWithAutocomplete();
        }
    }

    process.stdin.on('data', (_key) => {
        let incoming = _key as unknown as string;
        if (escPending) {
            if (escTimer) clearTimeout(escTimer);
            escTimer = null;
            escPending = false;
            if (!incoming.startsWith('\x1b')) incoming = `\x1b${incoming}`;
        }
        if (incoming === '\x1b') {
            escPending = true;
            escTimer = setTimeout(flushPendingEscape, ESC_WAIT_MS);
            return;
        }
        if (commandRunning && !inputActive) return;
        const beforeDisplay = getComposerDisplayText(composer);
        const tokens = consumePasteProtocol(incoming, pasteCapture, composer, { collapseLines: tuiConfig.pasteCollapseLines, collapseChars: tuiConfig.pasteCollapseChars });
        const afterDisplay = getComposerDisplayText(composer);
        if (beforeDisplay !== afterDisplay) {
            if (!inputActive) {
                if (commandRunning) return;
                inputActive = true;
                openPromptBlock();
            }
            redrawInputWithAutocomplete();
            if (tokens.length === 0) return;
        }
        for (const token of tokens) handleKeyInput(token);
    });

    // ─── WS messages ─────────────────────────
    ws.on('message', (data: Buffer | string) => {
        const raw = data.toString();
        try {
            const msg = JSON.parse(raw);
            switch (msg.type) {
                case 'agent_chunk':
                    if (ov.helpOpen || ov.paletteOpen) dismissOverlay();
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                        break;
                    }
                    clearEphemeralStatus(transcript);
                    if (!streaming) {
                        streaming = true;
                        startAssistantItem(transcript);
                        renderAssistantTurnStart();
                    }
                    appendToActiveAssistant(transcript, msg.text || '');
                    process.stdout.write((msg.text || '').replace(/\n/g, '\n  '));
                    break;

                case 'agent_done':
                    clearEphemeralStatus(transcript);
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (streaming) {
                        finalizeAssistant(transcript);
                        console.log('');
                    } else if (msg.text) {
                        startAssistantItem(transcript);
                        appendToActiveAssistant(transcript, msg.text);
                        finalizeAssistant(transcript);
                        renderAssistantTurnStart();
                        console.log(msg.text.replace(/\n/g, '\n  '));
                    }
                    // IDE diff: queue drain unconditional (mid-run /ide off safe)
                    if (isGit && preFileSetQueue.length > 0) {
                        const preSet = preFileSetQueue.shift()!;
                        if (ideEnabled) {
                            const postSet = captureFileSet(chatCwd);
                            const changed = diffFileSets(preSet, postSet);
                            if (changed.length > 0) {
                                const stat = getDiffStat(chatCwd, changed);
                                console.log(`\n  ${c.cyan}\u{1F4C2} ${changed.length}개 파일 변경됨${c.reset}`);
                                if (stat) console.log(`  ${stat}`);
                                else for (const f of changed.slice(0, 10)) console.log(`  ${c.dim}  ◦ ${f}${c.reset}`);
                                if (changed.length > 10) console.log(`  ${c.dim}  ... +${changed.length - 10}개${c.reset}`);
                                if (idePopEnabled && detectedIde) {
                                    console.log(`  ${c.dim}→ ${getIdeCli(detectedIde)}에서 diff 열기${c.reset}`);
                                    openDiffInIde(chatCwd, changed, detectedIde);
                                }
                            }
                        }
                    }
                    streaming = false;
                    inputActive = true;
                    openPromptBlock();
                    break;

                case 'agent_status':
                    // skip 'done' — redundant with agent_done, arrives late
                    if (msg.status === 'done') break;
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (msg.status === 'running') {
                        const name = msg.agentName || msg.agentId || 'agent';
                        appendStatusItem(transcript, `${name} working...`);
                        process.stdout.write(`\r  ${c.yellow}\u25CF${c.reset} ${c.dim}${name} working...${c.reset}          \r`);
                    }
                    break;

                case 'agent_tool':
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else if (msg.icon && msg.label) {
                        appendStatusItem(transcript, `${msg.icon} ${msg.label}`);
                        process.stdout.write(`\r  ${c.dim}${msg.icon} ${msg.label}${c.reset}          \r`);
                    }
                    break;

                case 'agent_fallback':
                    if (isRaw) {
                        console.log(`  ${c.dim}${raw}${c.reset}`);
                    } else {
                        appendStatusItem(transcript, `${msg.from} → ${msg.to}`);
                        process.stdout.write(`\r  ${c.yellow}⚡${c.reset} ${c.dim}${msg.from} → ${msg.to}${c.reset}          \r`);
                    }
                    break;

                case 'queue_update':
                    if (msg.pending > 0) {
                        appendStatusItem(transcript, `${msg.pending}개 대기 중`);
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
        cleanupScrollRegion(resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
        console.log(`\n  ${c.dim}Disconnected${c.reset}\n`);
        setBracketedPaste(false);
        process.stdin.setRawMode(false);
        process.exit(0);
    });

    setupScrollRegion(footer, `  ${c.dim}${hrLine()}${c.reset}`, resolveShellLayout(process.stdout.columns || 80, getRows(), panes));
    openPromptBlock();
}
