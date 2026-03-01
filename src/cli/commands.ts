// ─── Slash Commands Registry + Dispatcher ───────────────────────────────
// Handlers extracted to commands-handlers.js for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './registry.js';
import { t } from '../core/i18n.js';
import {
    formatDuration, unknownCommand, unsupportedCommand, normalizeResult,
    statusHandler, modelHandler, cliHandler, skillHandler, employeeHandler,
    clearHandler, resetHandler, versionHandler, mcpHandler, memoryHandler,
    browserHandler, promptHandler, quitHandler, fileHandler, fallbackHandler,
    steerHandler, flushHandler, forwardHandler, ideHandler,
    modelArgumentCompletions, cliArgumentCompletions, skillArgumentCompletions,
    employeeArgumentCompletions, browserArgumentCompletions, fallbackArgumentCompletions,
    flushArgumentCompletions,
} from './handlers.js';

const CATEGORY_ORDER = ['session', 'model', 'tools', 'cli'];
const CATEGORY_LABEL = {
    session: 'Session',
    model: 'Model',
    tools: 'Tools',
    cli: 'CLI',
};

function sortCommands(list: any[]) {
    return [...list].sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.category || 'tools');
        const bi = CATEGORY_ORDER.indexOf(b.category || 'tools');
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
    });
}

function displayUsage(cmd: any) {
    return `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`;
}

function toChoiceKey(value: any) {
    return String(value || '').trim().toLowerCase();
}

function normalizeArgumentCandidate(entry: any) {
    if (typeof entry === 'string') {
        const value = entry.trim();
        if (!value) return null;
        return { value, label: '' };
    }
    if (!entry || typeof entry !== 'object') return null;
    const value = String(entry.value ?? entry.name ?? '').trim();
    if (!value) return null;
    const label = String(entry.label ?? entry.desc ?? '').trim();
    return { value, label };
}

function dedupeChoices(list: any[]) {
    const out = [];
    const seen = new Set();
    for (const entry of list || []) {
        const key = toChoiceKey(entry?.value ?? entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

function scoreToken(value: any, query: any) {
    const target = toChoiceKey(value);
    const q = toChoiceKey(query);
    if (!q) return 0;
    if (!target) return -1;
    if (target === q) return 100;
    if (target.startsWith(q)) return 60;
    if (target.includes(q)) return 30;
    return -1;
}

function categoryIndex(category: any) {
    const idx = CATEGORY_ORDER.indexOf(category || 'tools');
    return idx >= 0 ? idx : CATEGORY_ORDER.length;
}

function scoreCommandCandidate(cmd: any, query: any) {
    const q = toChoiceKey(query);
    if (!q) return 0;
    let score = scoreToken(cmd.name, q);
    for (const alias of (cmd.aliases || [])) {
        const aliasScore = scoreToken(alias, q);
        if (aliasScore > score) score = aliasScore - 5;
    }
    return score;
}

function scoreArgumentCandidate(item: any, query: any) {
    const base = scoreToken(item.value, query);
    if (base >= 0) return base;
    const labelScore = scoreToken(item.label, query);
    if (labelScore >= 0) return Math.max(10, labelScore - 10);
    return -1;
}

function findCommand(name: any): any {
    const key = (name || '').toLowerCase();
    return COMMANDS.find(c => c.name === key || (c.aliases || []).includes(key));
}

// ─── helpHandler (kept here — needs COMMANDS/findCommand/sortCommands) ──

async function helpHandler(args: any[], ctx: any): Promise<any> {
    const iface = ctx.interface || 'cli';
    const L = ctx.locale || 'ko';
    if (args[0]) {
        const targetName = String(args[0]).replace(/^\//, '');
        const target: any = findCommand(targetName);
        if (!target) return unknownCommand(targetName, L);
        const desc = target.descKey ? t(target.descKey, {}, L) : target.desc;
        const lines: string[] = [
            `${displayUsage(target)} — ${desc}`,
            `interfaces: ${target.interfaces.join(', ')}`,
        ];
        return { ok: true, type: 'info', text: lines.join('\n') };
    }

    const available = sortCommands(COMMANDS.filter(c =>
        c.interfaces.includes(iface) && !c.hidden
    ));
    const byCategory = new Map();
    for (const cmd of available) {
        const cat = cmd.category || 'tools';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(cmd);
    }

    const lines = [t('cmd.helpTitle', {}, L)];
    for (const cat of CATEGORY_ORDER) {
        const cmds = byCategory.get(cat);
        if (!cmds?.length) continue;
        lines.push(`\n[${(CATEGORY_LABEL as Record<string, string>)[cat] || cat}]`);
        for (const cmd of cmds) {
            const desc = cmd.descKey ? t(cmd.descKey, {}, L) : cmd.desc;
            lines.push(`- ${displayUsage(cmd)} — ${desc}`);
        }
    }
    lines.push('\n' + t('cmd.helpDetail', {}, L));
    return { ok: true, type: 'info', text: lines.join('\n') };
}

// ─── COMMANDS Registry ───────────────────────────────

export const COMMANDS = [
    { name: 'help', aliases: ['h'], descKey: 'cmd.help.desc', tgDescKey: 'cmd.help.tg_desc', desc: 'Command list', args: '[command]', category: 'session', interfaces: ['cli', 'web', 'telegram'], handler: helpHandler },
    { name: 'status', descKey: 'cmd.status.desc', tgDescKey: 'cmd.status.tg_desc', desc: 'Current status', category: 'session', interfaces: ['cli', 'web', 'telegram'], handler: statusHandler },
    { name: 'clear', descKey: 'cmd.clear.desc', tgDescKey: 'cmd.clear.tg_desc', desc: 'Clear screen', category: 'session', interfaces: ['cli', 'web', 'telegram'], handler: clearHandler },
    { name: 'reset', descKey: 'cmd.reset.desc', desc: 'Full reset', args: '[confirm]', category: 'session', interfaces: ['cli', 'web'], handler: resetHandler },
    { name: 'model', descKey: 'cmd.model.desc', tgDescKey: 'cmd.model.tg_desc', desc: 'View/change model', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: modelArgumentCompletions, handler: modelHandler },
    { name: 'cli', descKey: 'cmd.cli.desc', tgDescKey: 'cmd.cli.tg_desc', desc: 'View/change CLI', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: cliArgumentCompletions, handler: cliHandler },
    { name: 'fallback', descKey: 'cmd.fallback.desc', tgDescKey: 'cmd.fallback.tg_desc', desc: 'Set fallback order', args: '[cli1 cli2...|off]', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: fallbackArgumentCompletions, handler: fallbackHandler },
    { name: 'forward', descKey: 'cmd.forward.desc', tgDescKey: 'cmd.forward.tg_desc', desc: 'Toggle Telegram forwarding (on/off)', args: '[on|off]', category: 'model', interfaces: ['cli', 'web', 'telegram'], handler: forwardHandler },
    { name: 'flush', descKey: 'cmd.flush.desc', tgDescKey: 'cmd.flush.tg_desc', desc: 'Set flush model', args: '[cli] [model] | off', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: flushArgumentCompletions, handler: flushHandler },
    { name: 'version', descKey: 'cmd.version.desc', tgDescKey: 'cmd.version.tg_desc', desc: 'Version/CLI status', category: 'cli', interfaces: ['cli', 'web', 'telegram'], handler: versionHandler },
    { name: 'skill', descKey: 'cmd.skill.desc', tgDescKey: 'cmd.skill.tg_desc', desc: 'Skill list/reset', args: '[list|reset]', category: 'tools', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: skillArgumentCompletions, handler: skillHandler },
    { name: 'employee', descKey: 'cmd.employee.desc', desc: 'Reset employees', args: 'reset', category: 'tools', interfaces: ['cli', 'web'], getArgumentCompletions: employeeArgumentCompletions, handler: employeeHandler },
    { name: 'mcp', descKey: 'cmd.mcp.desc', desc: 'MCP list/sync/install', args: '[sync|install]', category: 'tools', interfaces: ['cli', 'web'], handler: mcpHandler },
    { name: 'memory', descKey: 'cmd.memory.desc', desc: 'Memory search/list', args: '[query]', category: 'tools', interfaces: ['cli'], handler: memoryHandler },
    { name: 'browser', descKey: 'cmd.browser.desc', tgDescKey: 'cmd.browser.tg_desc', desc: 'Browser status/tabs', args: '[status|tabs]', category: 'tools', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: browserArgumentCompletions, handler: browserHandler },
    { name: 'prompt', descKey: 'cmd.prompt.desc', desc: 'View system prompt', category: 'tools', interfaces: ['cli', 'web'], handler: promptHandler },
    { name: 'quit', aliases: ['q', 'exit'], descKey: 'cmd.quit.desc', desc: 'Quit process', category: 'cli', interfaces: ['cli'], handler: quitHandler },
    { name: 'file', descKey: 'cmd.file.desc', desc: 'Attach file', args: '<path> [caption]', category: 'cli', interfaces: ['cli'], hidden: true, handler: fileHandler },
    { name: 'steer', descKey: 'cmd.steer.desc', tgDescKey: 'cmd.steer.tg_desc', desc: 'Interrupt agent and redirect', args: '<prompt>', category: 'session', interfaces: ['web', 'telegram'], handler: steerHandler },
    { name: 'ide', descKey: 'cmd.ide.desc', desc: 'IDE diff view', args: '[pop|on|off]', category: 'tools', interfaces: ['cli'], handler: ideHandler },
];

// ─── Dispatch ────────────────────────────────────────

export function parseCommand(text: any) {
    if (typeof text !== 'string' || !text.startsWith('/')) return null;
    const body = text.slice(1).trim();
    if (!body) {
        const help = findCommand('help');
        return { type: 'known', cmd: help, args: [], name: 'help' };
    }
    // File paths like /users/junny/... or /tmp/foo — not commands
    const firstToken = body.split(/\s+/)[0] || '';
    if (firstToken.includes('/') || firstToken.includes('\\')) return null;
    const parts = body.split(/\s+/);
    const name = (parts.shift() || '').toLowerCase();
    const cmd = findCommand(name);
    if (!cmd) return { type: 'unknown', name, args: parts };
    return { type: 'known', cmd, args: parts, name };
}

export async function executeCommand(parsed: any, ctx: any) {
    const L = ctx?.locale || 'ko';
    if (!parsed) return null;
    if (parsed.type === 'unknown') return unknownCommand(parsed.name, L);
    if (!parsed.cmd.interfaces.includes(ctx.interface || 'cli')) {
        return unsupportedCommand(parsed.cmd, ctx.interface || 'cli', L);
    }
    // Readonly enforcement: if command is readonly on this interface and args are supplied (write attempt), block
    if (ctx.interface && parsed.args?.length > 0) {
        const { getCommandCatalog, CAPABILITY } = await import('../command-contract/catalog.js');
        const catalogCmd = getCommandCatalog().find((c: any) => c.name === parsed.cmd.name);
        if (catalogCmd?.capability?.[ctx.interface] === CAPABILITY.readonly) {
            return {
                ok: false,
                code: 'readonly',
                text: t('cmd.unsupported', { name: parsed.cmd.name, iface: ctx.interface }, L),
            };
        }
    }
    try {
        return normalizeResult(await parsed.cmd.handler(parsed.args || [], ctx));
    } catch (err: unknown) {
        const msg = (err as Error)?.message || String(err);
        return {
            ok: false,
            code: 'command_error',
            text: t('cmd.error', { name: parsed.cmd.name, msg }, L),
        };
    }
}

// ─── Completions ─────────────────────────────────────

export function getCompletions(partial: any, iface = 'cli') {
    const prefix = (partial || '').startsWith('/')
        ? (partial || '').toLowerCase()
        : '/' + String(partial || '').toLowerCase();
    return getCompletionItems(prefix, iface)
        .map(c => `/${c.name}`);
}

export function getCompletionItems(partial: any, iface = 'cli', locale = 'ko') {
    const query = String(partial || '').replace(/^\//, '').trim().toLowerCase();
    return COMMANDS
        .filter(c => c.interfaces.includes(iface) && !c.hidden)
        .map(cmd => ({ cmd, score: scoreCommandCandidate(cmd, query) }))
        .filter(({ score }) => !query || score >= 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const catDiff = categoryIndex(a.cmd.category) - categoryIndex(b.cmd.category);
            if (catDiff !== 0) return catDiff;
            return a.cmd.name.localeCompare(b.cmd.name);
        })
        .map(({ cmd }) => ({
            kind: 'command',
            name: cmd.name,
            desc: cmd.descKey ? t(cmd.descKey, {}, locale) : cmd.desc,
            args: cmd.args || '',
            category: cmd.category || 'tools',
            insertText: `/${cmd.name}${cmd.args ? ' ' : ''}`,
        }));
}

export function getArgumentCompletionItems(commandName: any, partial = '', iface = 'cli', argv: any[] = [], ctx: any = {}) {
    const cmd = findCommand(commandName);
    if (!cmd || cmd.hidden) return [];
    if (!cmd.interfaces.includes(iface)) return [];
    if (typeof cmd.getArgumentCompletions !== 'function') return [];

    let candidates;
    try {
        candidates = cmd.getArgumentCompletions(ctx, argv, partial) || [];
    } catch (err: unknown) {
        if (process.env.DEBUG) console.warn('[commands:argComplete]', (err as Error).message);
        return [];
    }
    const normalized = dedupeChoices(candidates.map(normalizeArgumentCandidate).filter(Boolean));
    const query = String(partial || '').trim().toLowerCase();

    return normalized
        .map((entry, idx) => ({ entry, idx, score: scoreArgumentCandidate(entry, query) }))
        .filter(({ score }) => !query || score >= 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.idx !== b.idx) return a.idx - b.idx;
            return a.entry.value.localeCompare(b.entry.value);
        })
        .map(({ entry }) => ({
            kind: 'argument',
            name: entry.value,
            desc: entry.label,
            args: '',
            category: cmd.category || 'tools',
            command: cmd.name,
            commandDesc: cmd.desc,
            insertText: `/${cmd.name} ${entry.value}`,
        }));
}
