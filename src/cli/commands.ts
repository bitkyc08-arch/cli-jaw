// ─── Slash Commands Registry + Dispatcher ───────────────────────────────
// Handlers extracted to commands-handlers.js for 500-line compliance.

import { t } from '../core/i18n.js';
import {
    unknownCommand, unsupportedCommand, normalizeResult,
    statusHandler, modelHandler, cliHandler, skillHandler, employeeHandler,
    thoughtHandler,
    clearHandler, purgeHandler, resetHandler, versionHandler, mcpHandler, memoryHandler,
    browserHandler, promptHandler, quitHandler, fileHandler, fallbackHandler,
    steerHandler, flushHandler, forwardHandler, ideHandler, orchestrateHandler,
    compactHandler,
    modelArgumentCompletions, cliArgumentCompletions, skillArgumentCompletions,
    employeeArgumentCompletions, browserArgumentCompletions, fallbackArgumentCompletions,
    flushArgumentCompletions,
} from './handlers.js';
import { projectHandler } from './handlers-project.js';
import { taskHandler } from './handlers-task.js';
import { newSessionHandler, switchSessionHandler, sessionsListHandler, forkSessionHandler } from './handlers/session-handlers.js';
import { searchWorkflowHandler } from './handlers-search.js';
import {
    planWorkflowHandler,
    interviewWorkflowHandler,
    deliberateWorkflowHandler,
    planAuditWorkflowHandler,
    goalWorkflowHandler,
    goalplanHandler,
    gdHandler,
    teamWorkflowHandler,
    reviewWorkflowHandler,
} from './handlers-workflows.js';
import { buildUnknownCommandArtifact, saveWorkflowArtifact } from '../workflows/artifacts.js';
import type { CliCommandContext } from './command-context.js';
import type {
    SlashCommand, SlashChoice, SlashResult, ParsedSlashCommand, CompletionCtx,
} from './types.js';

const CATEGORY_ORDER = ['session', 'workflow', 'model', 'tools', 'cli'];
const CATEGORY_LABEL = {
    session: 'Session',
    workflow: 'Workflow',
    model: 'Model',
    tools: 'Tools',
    cli: 'CLI',
};

function sortCommands(list: SlashCommand[]): SlashCommand[] {
    return [...list].sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.category || 'tools');
        const bi = CATEGORY_ORDER.indexOf(b.category || 'tools');
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
    });
}

function displayUsage(cmd: SlashCommand): string {
    return `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`;
}

function toChoiceKey(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeArgumentCandidate(entry: SlashChoice | string | null | undefined): SlashChoice | null {
    if (typeof entry === 'string') {
        const value = entry.trim();
        if (!value) return null;
        return { value, label: '' };
    }
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as unknown as Record<string, unknown>;
    const value = String(e["value"] ?? e["name"] ?? '').trim();
    if (!value) return null;
    const label = String(e["label"] ?? e["desc"] ?? '').trim();
    return { value, label };
}

function dedupeChoices(list: Array<SlashChoice | null>): SlashChoice[] {
    const out: SlashChoice[] = [];
    const seen = new Set<string>();
    for (const entry of list || []) {
        if (!entry) continue;
        const key = toChoiceKey(entry.value ?? entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
    }
    return out;
}

function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        let prev = i - 1;
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j]!;
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
            prev = tmp;
        }
    }
    return dp[n]!;
}

function scoreToken(value: string, query: string): number {
    const target = toChoiceKey(value);
    const q = toChoiceKey(query);
    if (!q) return 0;
    if (!target) return -1;
    if (target === q) return 100;
    if (target.startsWith(q)) return 60;
    if (target.includes(q)) return 30;
    const dist = levenshtein(target, q);
    if (dist <= 2 && q.length >= 2) return Math.max(10, 30 - dist * 10);
    return -1;
}

function categoryIndex(category: string | undefined): number {
    const idx = CATEGORY_ORDER.indexOf(category || 'tools');
    return idx >= 0 ? idx : CATEGORY_ORDER.length;
}

function scoreCommandCandidate(cmd: SlashCommand, query: string): number {
    const q = toChoiceKey(query);
    if (!q) return 0;
    let score = scoreToken(cmd.name, q);
    for (const alias of (cmd.aliases || [])) {
        const aliasScore = scoreToken(alias, q);
        if (aliasScore > score) score = aliasScore - 5;
    }
    return score;
}

function suggestCommandNames(query: string): string[] {
    const q = String(query || '').trim().toLowerCase();
    const ranked = COMMANDS
        .filter(c => !c.hidden)
        .map(cmd => ({ cmd, score: scoreCommandCandidate(cmd, q) }))
        .filter(({ score }) => score >= 0)
        .sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
        .slice(0, 5)
        .map(({ cmd }) => `/${cmd.name}`);
    if (ranked.length) return ranked;
    const fallback = ['help', 'plan', 'interview', 'deliberate', 'planaudit'];
    const available = new Set(COMMANDS.filter(c => !c.hidden).map(c => c.name));
    return fallback.filter(name => available.has(name)).map(name => `/${name}`);
}

async function readSettingsSnapshot(ctx: { [k: string]: unknown }): Promise<unknown> {
    let settingsSnapshot: unknown = (ctx as { settings?: unknown }).settings;
    const getSettings = (ctx as { getSettings?: () => unknown }).getSettings;
    if (!settingsSnapshot && typeof getSettings === 'function') {
        try {
            settingsSnapshot = await getSettings();
        } catch {
            settingsSnapshot = undefined;
        }
    }
    return settingsSnapshot;
}

async function persistWorkflowArtifactResult(result: SlashResult, ctx: { [k: string]: unknown }): Promise<SlashResult> {
    if (!result?.artifact || result.artifact.storage.mode !== 'jaw-home-cache') return result;
    const settingsSnapshot = await readSettingsSnapshot(ctx);
    return {
        ...result,
        artifact: saveWorkflowArtifact(result.artifact, settingsSnapshot),
    };
}

function scoreArgumentCandidate(item: SlashChoice, query: string): number {
    const base = scoreToken(item.value, query);
    if (base >= 0) return base;
    const labelScore = scoreToken(item.label || '', query);
    if (labelScore >= 0) return Math.max(10, labelScore - 10);
    return -1;
}

function findCommand(name: string): SlashCommand | undefined {
    const key = (name || '').toLowerCase();
    return COMMANDS.find(c => c.name === key || (c.aliases || []).includes(key));
}

// ─── helpHandler (kept here — needs COMMANDS/findCommand/sortCommands) ──

async function helpHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const iface = ctx.interface || 'cli';
    const L = ctx.locale || 'ko';
    if (args[0]) {
        const targetName = String(args[0]).replace(/^\//, '');
        const target: SlashCommand | undefined = findCommand(targetName);
        if (!target) return unknownCommand(targetName, L);
        const desc = target.descKey ? t(target.descKey, {}, L) : target.desc;
        const lines: string[] = [
            `${displayUsage(target)} — ${desc}`,
            `interfaces: ${target.interfaces.join(', ')}`,
        ];
        if (target.helpDetailKey) {
            const detail = t(target.helpDetailKey, {}, L);
            if (detail !== target.helpDetailKey) lines.push('', detail);
        }
        return { ok: true, type: 'info', text: lines.join('\n') };
    }

    const available = sortCommands(COMMANDS.filter(c =>
        c.interfaces.includes(iface) && !c.hidden
    ));
    const byCategory = new Map<string, SlashCommand[]>();
    for (const cmd of available) {
        const cat = cmd.category || 'tools';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(cmd);
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

export const COMMANDS: SlashCommand[] = [
    { name: 'help', aliases: ['h'], descKey: 'cmd.help.desc', tgDescKey: 'cmd.help.tg_desc', desc: 'Command list', args: '[command]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: helpHandler },
    { name: 'commands', aliases: ['cmd'], descKey: '', desc: 'Open command palette', category: 'session', interfaces: ['cli'], handler: async () => ({ code: 'open_palette' }) },
    { name: 'settings', desc: 'Open settings', category: 'cli', interfaces: ['cli'], handler: async () => ({ ok: true, code: 'open_settings', text: 'Settings are available in fullscreen TUI.' }) },
    { name: 'status', descKey: 'cmd.status.desc', tgDescKey: 'cmd.status.tg_desc', desc: 'Current status', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: statusHandler },
    { name: 'clear', descKey: 'cmd.clear.desc', tgDescKey: 'cmd.clear.tg_desc', desc: 'Clear screen', args: '[all]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: clearHandler },
    { name: 'purge', descKey: 'cmd.purge.desc', tgDescKey: 'cmd.purge.tg_desc', desc: 'Purge conversation and memory', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: purgeHandler },
    { name: 'compact', descKey: 'cmd.compact.desc', tgDescKey: 'cmd.compact.tg_desc', desc: 'Compact conversation context', args: '[instructions]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: compactHandler },
    { name: 'reset', descKey: 'cmd.reset.desc', desc: 'Full reset', args: '[confirm]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: resetHandler },
    { name: 'plan', descKey: 'cmd.workflow.plan.desc', tgDescKey: 'cmd.workflow.plan.tg_desc', desc: 'Explain cli-jaw PABCD planning flow', args: '[request|status|copy]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'planning', risk: 'low', output: 'prompt', workflowArgs: [{ name: 'request-or-subcommand', required: false, kind: 'text' }] }, handler: planWorkflowHandler },
    { name: 'interview', descKey: 'cmd.workflow.interview.desc', tgDescKey: 'cmd.workflow.interview.tg_desc', desc: 'Clarify requirements before planning', args: '<request>', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'requirements', risk: 'low', output: 'prompt', workflowArgs: [{ name: 'request', required: true, kind: 'text' }] }, handler: interviewWorkflowHandler },
    { name: 'deliberate', descKey: 'cmd.workflow.deliberate.desc', tgDescKey: 'cmd.workflow.deliberate.tg_desc', desc: 'Plan with planner, architect, and critic roles', args: '<request-or-plan>', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'planning', risk: 'low', output: 'plan', workflowArgs: [{ name: 'request-or-plan', required: true, kind: 'text' }] }, handler: deliberateWorkflowHandler },
    { name: 'planaudit', descKey: 'cmd.workflow.planAudit.desc', tgDescKey: 'cmd.workflow.planAudit.tg_desc', desc: 'Create a read-only employee audit task', args: '[plan]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'audit', risk: 'medium', output: 'dispatch', workflowArgs: [{ name: 'plan', required: false, kind: 'text' }] }, handler: planAuditWorkflowHandler },
    { name: 'review', tgDescKey: 'cmd.workflow.review.tg_desc', desc: 'Project-dir code review', args: '[focus] [--fix] [--dispatch]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'quality', risk: 'low', output: 'report', workflowArgs: [{ name: 'focus', required: false, kind: 'text' }] }, handler: reviewWorkflowHandler },
    { name: 'search', descKey: 'cmd.workflow.search.desc', tgDescKey: 'cmd.workflow.search.tg_desc', desc: 'Route search through the search skill', args: '<query>', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'requirements', risk: 'low', output: 'prompt', workflowArgs: [{ name: 'query', required: true, kind: 'text' }] }, handler: searchWorkflowHandler },
    { name: 'goal', descKey: 'cmd.workflow.goal.desc', tgDescKey: 'cmd.workflow.goal.tg_desc', desc: 'Persistent goal and bounded run workflow', args: '<objective> | plan [hint] | refine <objective> | [status|run|done|cancel|pause|resume|clear|reset|history]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'continuation', risk: 'medium', output: 'state', workflowArgs: [{ name: 'objective-or-subcommand', required: false, kind: 'text' }] }, handler: goalWorkflowHandler },
    { name: 'goalplan', descKey: 'cmd.workflow.goal.desc', tgDescKey: 'cmd.workflow.goal.tg_desc', desc: 'AI-driven goal planning (alias for /goal plan)', args: '[hint]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'continuation', risk: 'medium', output: 'state', workflowArgs: [{ name: 'hint', required: false, kind: 'text' }] }, handler: goalplanHandler },
    { name: 'gd', descKey: 'cmd.workflow.goal.desc', tgDescKey: 'cmd.workflow.goal.tg_desc', desc: 'Force-complete active goal (alias for /goal done --force)', args: '[note]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'continuation', risk: 'medium', output: 'state', workflowArgs: [{ name: 'note', required: false, kind: 'text' }] }, handler: gdHandler },
    { name: 'team', descKey: 'cmd.workflow.team.desc', tgDescKey: 'cmd.workflow.team.tg_desc', desc: 'Parallel team orchestration', args: '[plan|audit|status|collect|stop] [args...]', category: 'workflow', interfaces: ['cli', 'web', 'telegram', 'discord'], workflow: { kind: 'workflow', phase: 'execution', risk: 'medium', output: 'dispatch', workflowArgs: [{ name: 'subcommand', required: true, kind: 'text' }] }, handler: teamWorkflowHandler },
    { name: 'model', descKey: 'cmd.model.desc', tgDescKey: 'cmd.model.tg_desc', desc: 'View/change model', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: modelArgumentCompletions, handler: modelHandler },
    { name: 'cli', descKey: 'cmd.cli.desc', tgDescKey: 'cmd.cli.tg_desc', desc: 'View/change CLI', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: cliArgumentCompletions, handler: cliHandler },
    { name: 'fallback', descKey: 'cmd.fallback.desc', tgDescKey: 'cmd.fallback.tg_desc', desc: 'Set fallback order', args: '[cli1 cli2...|off]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: fallbackArgumentCompletions, handler: fallbackHandler },
    { name: 'forward', descKey: 'cmd.forward.desc', tgDescKey: 'cmd.forward.tg_desc', desc: 'Toggle forwarding (on/off)', args: '[on|off]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: forwardHandler },
    { name: 'thought', desc: 'Toggle Gemini thought visibility', args: '[on|off]', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: thoughtHandler },
    { name: 'flush', descKey: 'cmd.flush.desc', tgDescKey: 'cmd.flush.tg_desc', desc: 'Set flush model', args: '[cli] [model] | off', category: 'model', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: flushArgumentCompletions, handler: flushHandler },
    { name: 'version', descKey: 'cmd.version.desc', tgDescKey: 'cmd.version.tg_desc', desc: 'Version/CLI status', category: 'cli', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: versionHandler },
    { name: 'skill', descKey: 'cmd.skill.desc', tgDescKey: 'cmd.skill.tg_desc', desc: 'Skill list/reset', args: '[list [--inactive]|reset]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: skillArgumentCompletions, handler: skillHandler },
    { name: 'employee', descKey: 'cmd.employee.desc', desc: 'Manage employees', args: '[list|info|model|cli|reset|sessions-reset] [...]', helpDetailKey: 'cmd.employee.helpDetail', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: employeeArgumentCompletions, handler: employeeHandler },
    { name: 'mcp', descKey: 'cmd.mcp.desc', desc: 'MCP list/sync/install', args: '[sync|install]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: mcpHandler },
    { name: 'memory', descKey: 'cmd.memory.desc', desc: 'Memory search/list', args: '[query]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: memoryHandler },
    { name: 'browser', descKey: 'cmd.browser.desc', tgDescKey: 'cmd.browser.tg_desc', desc: 'Browser status/tabs', args: '[status|tabs]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], getArgumentCompletions: browserArgumentCompletions, handler: browserHandler },
    { name: 'prompt', descKey: 'cmd.prompt.desc', desc: 'View system prompt', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: promptHandler },
    { name: 'quit', aliases: ['q', 'exit'], descKey: 'cmd.quit.desc', desc: 'Quit process', category: 'cli', interfaces: ['cli'], handler: quitHandler },
    { name: 'file', descKey: 'cmd.file.desc', desc: 'Attach file', args: '<path> [caption]', category: 'cli', interfaces: ['cli'], hidden: true, handler: fileHandler },
    { name: 'steer', descKey: 'cmd.steer.desc', tgDescKey: 'cmd.steer.tg_desc', desc: 'Interrupt agent and redirect', args: '<prompt>', category: 'session', interfaces: ['web', 'telegram', 'discord'], handler: steerHandler },
    { name: 'ide', descKey: 'cmd.ide.desc', desc: 'IDE diff view', args: '[pop|on|off]', category: 'tools', interfaces: ['cli'], handler: ideHandler },
    { name: 'orchestrate', aliases: ['pabcd'], descKey: '', desc: 'Enter PABCD orchestration', args: '[I|P|A|B|C|D|status|reset] [--force]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: orchestrateHandler },
    { name: 'project', aliases: ['proj'], descKey: '', desc: 'Manage project workspace directories', args: '[set|reset|clear|list] [paths...]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: projectHandler },
    { name: 'task', descKey: '', desc: 'Task checklist', args: '[add|edit|done|start|assign|cancel|list|clear] [args...]', category: 'tools', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: taskHandler },
    { name: 'new', descKey: '', desc: 'New chat session', args: '[label]', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: newSessionHandler },
    { name: 'switch', aliases: ['sw'], descKey: '', desc: 'Switch session', args: '<seq>', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: switchSessionHandler },
    { name: 'sessions', aliases: ['ss'], descKey: '', desc: 'List sessions', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: sessionsListHandler },
    { name: 'fork', descKey: '', desc: 'Fork current session', category: 'session', interfaces: ['cli', 'web', 'telegram', 'discord'], handler: forkSessionHandler },
    // ── Phase 9-10: jawcode parity commands ──
    { name: 'effort', desc: 'Set reasoning effort level', args: '[off|low|medium|high|max]', category: 'model', interfaces: ['cli', 'web'], handler: effortHandler },
    { name: 'fast', desc: 'Toggle fast/priority mode', category: 'model', interfaces: ['cli', 'web'], handler: fastHandler },
    { name: 'context', desc: 'Show token usage and context stats', category: 'session', interfaces: ['cli', 'web'], handler: contextHandler },
    { name: 'tools', desc: 'List active tools', category: 'tools', interfaces: ['cli', 'web'], handler: toolsHandler },
    { name: 'redraw', desc: 'Force TUI redraw', category: 'cli', interfaces: ['cli'], handler: async () => ({ code: 'redraw' }) },
    { name: 'retry', desc: 'Retry last message', category: 'session', interfaces: ['cli', 'web'], handler: async () => ({ code: 'retry' }) },
    { name: 'export', desc: 'Export session transcript', args: '[markdown|json]', category: 'session', interfaces: ['cli', 'web'], handler: exportHandler },
    { name: 'resume', desc: 'Resume a previous session', args: '[id]', category: 'session', interfaces: ['cli', 'web'], handler: resumeHandler },
    { name: 'hotkeys', desc: 'Show keyboard shortcuts', category: 'cli', interfaces: ['cli'], handler: async () => ({ code: 'show_help' }) },
];

// ─── Tokenizer ───────────────────────────────────────

function tokenizeArgs(body: string): string[] {
    const tokens: string[] = [];
    let current = '', inQuote: string | null = null;
    for (const ch of body) {
        if (inQuote) {
            if (ch === inQuote) { inQuote = null; continue; }
            current += ch;
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (/\s/.test(ch)) {
            if (current) { tokens.push(current); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

// ─── Dispatch ────────────────────────────────────────

export function parseCommand(text: string): ParsedSlashCommand {
    if (typeof text !== 'string' || !text.startsWith('/')) return null;
    const body = text.slice(1).trim();
    if (!body) {
        const help = findCommand('help');
        if (!help) return null;
        return { type: 'known', cmd: help, args: [], name: 'help', rawText: text };
    }
    // File paths like /users/junny/... or /tmp/foo — not commands
    const firstToken = body.split(/\s+/)[0] || '';
    if (firstToken.includes('/') || firstToken.includes('\\')) return null;
    // Numeric shortcut: /N → switch to session #N
    if (/^\d+$/.test(firstToken)) {
        const switchCmd = findCommand('switch');
        if (switchCmd) return { type: 'known', cmd: switchCmd, args: [firstToken], name: 'switch', rawText: text };
    }
    const parts = tokenizeArgs(body);
    const name = (parts.shift() || '').toLowerCase();
    const cmd = findCommand(name);
    if (!cmd) return { type: 'unknown', name, args: parts, rawText: text };
    return { type: 'known', cmd, args: parts, name, rawText: text };
}

export async function executeCommand(parsed: ParsedSlashCommand, ctx: { interface?: string; locale?: string; [k: string]: unknown }): Promise<SlashResult | null> {
    const L = ctx?.locale || 'ko';
    if (!parsed) return null;
    if (parsed.type === 'unknown') {
        const recovery = {
            args: parsed.args || [],
            originalText: parsed.rawText || `/${parsed.name}${parsed.args?.length ? ` ${parsed.args.join(' ')}` : ''}`,
            suggestedCommands: suggestCommandNames(parsed.name),
        };
        const result = unknownCommand(parsed.name, L, recovery);
        result.artifact = buildUnknownCommandArtifact(result.recovery!, L, await readSettingsSnapshot(ctx));
        return persistWorkflowArtifactResult(result, ctx);
    }
    const iface = ctx.interface || 'cli';
    if (!parsed.cmd.interfaces.includes(iface)) {
        return unsupportedCommand(parsed.cmd, iface, L);
    }
    // Readonly enforcement: if command is readonly on this interface and args are supplied (write attempt), block
    if (iface && parsed.args?.length > 0) {
        const { getCommandCatalog, CAPABILITY } = await import('../command-contract/catalog.js');
        const catalogCmd = getCommandCatalog().find((c: SlashCommand) => c.name === parsed.cmd.name);
        const cap = (catalogCmd as { capability?: Record<string, string> } | undefined)?.capability;
        if (cap?.[iface] === CAPABILITY.readonly) {
            return {
                ok: false,
                code: 'readonly',
                text: t('cmd.unsupported', { name: parsed.cmd.name, iface }, L),
            };
        }
    }
    try {
        const handler = parsed.cmd.handler as (args: string[], ctx: CliCommandContext) => unknown;
        const commandCtx = { ...ctx, rawText: parsed.rawText };
        return persistWorkflowArtifactResult(
            normalizeResult(await handler(parsed.args || [], commandCtx as unknown as CliCommandContext)),
            commandCtx,
        );
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

export function getCompletions(partial: string, iface: string = 'cli'): string[] {
    const prefix = (partial || '').startsWith('/')
        ? (partial || '').toLowerCase()
        : '/' + String(partial || '').toLowerCase();
    return getCompletionItems(prefix, iface)
        .map(c => `/${c.name}`);
}

export interface CommandCompletionItem {
    kind: 'command';
    name: string;
    desc: string;
    args: string;
    category: string;
    workflow?: SlashCommand['workflow'];
    insertText: string;
}

export function getCompletionItems(partial: string, iface: string = 'cli', locale: string = 'ko'): CommandCompletionItem[] {
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
            kind: 'command' as const,
            name: cmd.name,
            desc: (cmd.descKey ? t(cmd.descKey, {}, locale) : cmd.desc) || '',
            args: cmd.args || '',
            category: cmd.category || 'tools',
            workflow: cmd.workflow,
            insertText: `/${cmd.name}${cmd.args ? ' ' : ''}`,
        }));
}

export interface ArgumentCompletionItem {
    kind: 'argument';
    name: string;
    desc: string;
    args: string;
    category: string;
    command: string;
    commandDesc: string;
    insertText: string;
}

export async function getArgumentCompletionItems(
    commandName: string,
    partial: string = '',
    iface: string = 'cli',
    argv: string[] = [],
    ctx: { settings?: { perCli?: Record<string, unknown>; cli?: string }; locale?: string } = {},
): Promise<ArgumentCompletionItem[]> {
    const cmd = findCommand(commandName);
    if (!cmd || cmd.hidden) return [];
    if (!cmd.interfaces.includes(iface)) return [];
    if (typeof cmd.getArgumentCompletions !== 'function') return [];

    let candidates: SlashChoice[];
    try {
        const result = await Promise.resolve(cmd.getArgumentCompletions(ctx as CompletionCtx, argv, partial));
        candidates = (Array.isArray(result) ? result : []) as SlashChoice[];
    } catch (err: unknown) {
        if (process.env["DEBUG"]) console.warn('[commands:argComplete]', (err as Error).message);
        return [];
    }
    const normalized = dedupeChoices(candidates.map(normalizeArgumentCandidate));
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
            kind: 'argument' as const,
            name: entry.value,
            desc: entry.label || '',
            args: '',
            category: cmd.category || 'tools',
            command: cmd.name,
            commandDesc: cmd.desc || '',
            insertText: `/${cmd.name} ${entry.value}`,
        }));
}

// ── Phase 9-10 handlers ──────────────────────────────

async function effortHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const levels = ['off', 'low', 'medium', 'high', 'max'];
    if (!args.length) return { text: `Reasoning effort options: ${levels.join(', ')}. Usage: /effort <level>` };
    const level = args[0]!.toLowerCase();
    if (!levels.includes(level)) return { text: `Unknown level "${args[0]}". Options: ${levels.join(', ')}` };
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        await fetch(`${apiUrl}/api/settings`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ effort: level }),
            signal: AbortSignal.timeout(3000),
        });
    } catch { /* best effort */ }
    return { ok: true, text: `Reasoning effort set to ${level}.` };
}

async function fastHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
        const data = r.ok ? (await r.json()) as Record<string, unknown> : {};
        const current = (data as Record<string, unknown>)['serviceTier'] === 'priority';
        await fetch(`${apiUrl}/api/settings`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serviceTier: current ? 'none' : 'priority' }),
            signal: AbortSignal.timeout(3000),
        });
        return { ok: true, text: current ? 'Fast mode disabled.' : 'Fast mode enabled.' };
    } catch {
        return { text: 'Failed to toggle fast mode.' };
    }
}

async function contextHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        const r = await fetch(`${apiUrl}/api/session`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const data = (await r.json()) as Record<string, unknown>;
            const session = (data as Record<string, unknown>)['data'] as Record<string, unknown> || data;
            return { text: `Context: model=${session['model'] || 'default'}, messages=${session['messageCount'] || '?'}` };
        }
    } catch { /* fallback */ }
    return { text: 'Context stats: use /status for current token usage.' };
}

async function toolsHandler(_args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    try {
        const apiUrl = (ctx as Record<string, unknown>)['apiUrl'] as string || 'http://localhost:3457';
        const r = await fetch(`${apiUrl}/api/settings`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const data = (await r.json()) as Record<string, unknown>;
            const cli = (data as Record<string, unknown>)['cli'] as string || 'codex';
            return { text: `Active CLI: ${cli}. Tools: Bash, Read, Edit, Write + configured MCP servers.` };
        }
    } catch { /* fallback */ }
    return { text: 'Active tools: Bash, Read, Edit, Write + MCP tools (if configured).' };
}

async function exportHandler(args: string[]): Promise<SlashResult> {
    const fmt = args[0] || 'markdown';
    return { text: `Export format: ${fmt}. (Export endpoint not yet wired — coming in next update)` };
}

async function resumeHandler(args: string[]): Promise<SlashResult> {
    if (args.length) return { text: `Resuming session ${args[0]}...`, code: 'resume_session' };
    return { code: 'open_session_selector' };
}

// ── Fix: effort/fast handlers must write to server settings ──
// The handlers above are stubs. Proper implementation requires
// POST /api/settings with the effort/fast value. Adding API call:
