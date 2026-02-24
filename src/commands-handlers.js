// ─── Slash Command Handlers ─────────────────────────
// Extracted from commands.js for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './cli-registry.js';
import { t } from './core/i18n.js';

const DEFAULT_CLI_CHOICES = [...CLI_KEYS];
const MODEL_CHOICES_BY_CLI = buildModelChoicesByCli();

function toChoiceKey(value) {
    return String(value || '').trim().toLowerCase();
}

function dedupeChoices(list) {
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

function getCliChoicesFromContext(ctx) {
    const keys = Object.keys(ctx?.settings?.perCli || {});
    return keys.length ? keys : DEFAULT_CLI_CHOICES;
}

function getModelChoicesFromContext(ctx) {
    const fromCatalog = Object.values(MODEL_CHOICES_BY_CLI).flat();
    const fromSettings = Object.values(ctx?.settings?.perCli || {})
        .map(v => v?.model)
        .filter(Boolean);
    const activeCli = ctx?.settings?.cli || '';
    const currentModel = ctx?.settings?.perCli?.[activeCli]?.model;
    return dedupeChoices([...fromCatalog, ...fromSettings, ...(currentModel ? [currentModel] : [])]);
}

async function safeCall(fn, fallback = null) {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch (err) {
        if (process.env.DEBUG) console.warn('[commands:safeCall]', err.message);
        return fallback;
    }
}

export function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function unknownCommand(name, locale = 'ko') {
    return {
        ok: false,
        type: 'error',
        code: 'unknown_command',
        text: t('cmd.unknown', { name }, locale),
    };
}

export function unsupportedCommand(cmd, iface, locale = 'ko') {
    return {
        ok: false,
        type: 'error',
        code: 'unsupported_interface',
        text: t('cmd.unsupported', { name: cmd.name, iface }, locale),
    };
}

export function normalizeResult(result) {
    if (!result) return { ok: true, type: 'success', text: '' };
    if (typeof result === 'string') return { ok: true, type: 'info', text: result };
    if (typeof result === 'object') {
        const ok = result.ok !== false;
        const type = result.type || (ok ? 'success' : 'error');
        return { ok, type, ...result };
    }
    return { ok: true, type: 'info', text: String(result) };
}

// ─── Individual Handlers ─────────────────────────────
// helpHandler is kept in commands.js (needs COMMANDS/findCommand access)

export async function statusHandler(_args, ctx) {
    const [settings, session, runtime, skills] = await Promise.all([
        safeCall(ctx.getSettings, null),
        safeCall(ctx.getSession, null),
        safeCall(ctx.getRuntime, null),
        safeCall(ctx.getSkills, []),
    ]);

    const cli = settings?.cli || session?.active_cli || 'unknown';
    const model = settings?.perCli?.[cli]?.model || session?.model || 'default';
    const effort = settings?.perCli?.[cli]?.effort || session?.effort || '-';
    const agent = runtime?.activeAgent === true
        ? '● running'
        : runtime?.activeAgent === false ? '○ idle' : '-';
    const queuePending = runtime?.queuePending ?? '-';
    const uptime = formatDuration(runtime?.uptimeSec);
    const activeSkills = Array.isArray(skills) ? skills.filter(s => s.enabled).length : '-';
    const refSkills = Array.isArray(skills) ? skills.filter(s => !s.enabled).length : '-';

    const fb = settings?.fallbackOrder || [];

    return {
        ok: true,
        type: 'info',
        text: [
            `🦞 cli-claw v${ctx.version || 'unknown'}`,
            `CLI:      ${cli}`,
            `Model:    ${model}`,
            `Effort:   ${effort || '-'}`,
            ...(fb.length ? [`Fallback: ${fb.join(' → ')}`] : []),
            `Uptime:   ${uptime}`,
            `Agent:    ${agent}`,
            `Queue:    ${queuePending}`,
            `Skills:   ${activeSkills} active, ${refSkills} ref`,
        ].join('\n'),
    };
}

export async function modelHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const activeCli = settings.cli || 'claude';
    const current = settings.perCli?.[activeCli]?.model || 'default';

    if (!args.length) {
        return { ok: true, text: t('cmd.model.current', { cli: activeCli, model: current }, L) };
    }

    const nextModel = args.join(' ').trim();
    if (!nextModel || nextModel.length > 200 || /[\r\n]/.test(nextModel)) {
        return { ok: false, text: t('cmd.model.invalid', {}, L) };
    }

    const nextPerCli = {
        ...(settings.perCli || {}),
        [activeCli]: {
            ...(settings.perCli?.[activeCli] || {}),
            model: nextModel,
        },
    };
    const updateResult = await ctx.updateSettings({ perCli: nextPerCli });
    if (updateResult?.ok === false) return updateResult;
    return {
        ok: true,
        text: t('cmd.model.changed', { model: nextModel }, L),
    };
}

export async function cliHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const allowed = Object.keys(settings.perCli || {});
    const fallbackAllowed = allowed.length ? allowed : DEFAULT_CLI_CHOICES;
    const current = settings.cli || 'claude';

    if (!args.length) {
        return {
            ok: true,
            text: t('cmd.cli.current', { cli: current, available: fallbackAllowed.join(', ') }, L),
        };
    }

    const nextCli = args[0].toLowerCase();
    if (!fallbackAllowed.includes(nextCli)) {
        return {
            ok: false,
            text: t('cmd.cli.unknown', { cli: nextCli, available: fallbackAllowed.join(', ') }, L),
        };
    }

    if (nextCli === current) {
        return { ok: true, text: t('cmd.cli.already', { cli: nextCli }, L) };
    }

    const updateResult = await ctx.updateSettings({ cli: nextCli });
    if (updateResult?.ok === false) return updateResult;
    return { ok: true, text: t('cmd.cli.changed', { from: current, to: nextCli }, L) };
}

export async function skillHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
        const skills = await safeCall(ctx.getSkills, []);
        if (!Array.isArray(skills)) return { ok: false, text: t('cmd.skill.loadFail', {}, L) };
        const active = skills.filter(s => s.enabled).length;
        const ref = skills.filter(s => !s.enabled).length;
        return { ok: true, text: `🧰 Skills: ${active} active, ${ref} ref` };
    }
    if (sub === 'reset') {
        if (typeof ctx.resetSkills !== 'function') {
            return { ok: false, text: t('cmd.skill.resetUnavailable', {}, L) };
        }
        await ctx.resetSkills();
        return { ok: true, text: t('cmd.skill.resetDone', {}, L) };
    }
    return { ok: false, text: 'Usage: /skill [list|reset]' };
}

export async function employeeHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();
    if (sub !== 'reset') {
        return { ok: false, text: 'Usage: /employee reset' };
    }
    if (typeof ctx.resetEmployees !== 'function') {
        return { ok: false, text: t('cmd.employee.resetUnavailable', {}, L) };
    }
    const result = await ctx.resetEmployees();
    const seeded = Number.isFinite(result?.seeded) ? result.seeded : '?';
    return { ok: true, text: t('cmd.employee.resetDone', { count: seeded }, L) };
}

export async function clearHandler(_args, ctx) {
    const L = ctx.locale || 'ko';
    if ((ctx.interface || 'cli') === 'telegram') {
        return { ok: true, text: t('cmd.clear.telegram', {}, L) };
    }
    return {
        ok: true,
        code: 'clear_screen',
        text: t('cmd.clear.done', {}, L),
    };
}

export async function resetHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    if ((args[0] || '').toLowerCase() !== 'confirm') {
        return {
            ok: false,
            text: t('cmd.reset.confirm', {}, L),
        };
    }
    const results = [];
    if (typeof ctx.resetSkills === 'function') {
        await ctx.resetSkills();
        results.push(t('cmd.reset.skills', {}, L));
    }
    if (typeof ctx.resetEmployees === 'function') {
        await ctx.resetEmployees();
        results.push(t('cmd.reset.employees', {}, L));
    }
    if (typeof ctx.syncMcp === 'function') {
        await ctx.syncMcp();
        results.push('MCP');
    }
    if (typeof ctx.clearSession === 'function') {
        await ctx.clearSession();
        results.push(t('cmd.reset.sessions', {}, L));
    }
    if (!results.length) {
        return { ok: false, text: t('cmd.reset.unavailable', {}, L) };
    }
    return { ok: true, text: t('cmd.reset.done', { items: results.join(', ') }, L) };
}

export async function versionHandler(_args, ctx) {
    const status = await safeCall(ctx.getCliStatus, null);
    const lines = [`cli-claw v${ctx.version || 'unknown'}`];
    if (status && typeof status === 'object') {
        for (const key of DEFAULT_CLI_CHOICES) {
            if (!status[key]) continue;
            const entry = status[key];
            const icon = entry.available ? '✅' : '❌';
            lines.push(`${key}: ${icon}${entry.path ? ` ${entry.path}` : ''}`);
        }
    }
    return { ok: true, text: lines.join('\n') };
}

export async function mcpHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'sync') {
        const d = await ctx.syncMcp();
        const keys = Object.keys(d?.results || {});
        return { ok: true, text: t('cmd.mcp.syncDone', { count: keys.length }, L) };
    }
    if (sub === 'install') {
        const d = await ctx.installMcp();
        const keys = Object.keys(d?.results || {});
        return { ok: true, text: t('cmd.mcp.installDone', { count: keys.length }, L) };
    }
    const d = await ctx.getMcp();
    const names = Object.keys(d?.servers || {});
    return {
        ok: true,
        text: `MCP servers (${names.length}): ${names.join(', ') || '(none)'}\n/mcp sync\n/mcp install`,
    };
}

export async function memoryHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    if (!args.length || (args.length === 1 && args[0].toLowerCase() === 'list')) {
        const files = await ctx.listMemory();
        if (!files?.length) return { ok: true, text: t('cmd.memory.empty', {}, L) };
        const lines = files.slice(0, 20).map(f => `- ${f.path} (${f.size}b)`);
        return { ok: true, text: `🧠 memory files (${files.length})\n${lines.join('\n')}` };
    }
    const query = args.join(' ').trim();
    const result = await ctx.searchMemory(query);
    const text = String(result || '(no results)');
    const MAX = 3000;
    return { ok: true, text: text.length > MAX ? text.slice(0, MAX) + '\n...(truncated)' : text };
}

export async function browserHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'tabs') {
        const d = await ctx.getBrowserTabs();
        const tabs = d?.tabs || [];
        if (!tabs.length) return { ok: true, text: t('cmd.browser.noTabs', {}, L) };
        const lines = tabs.slice(0, 10).map((tab, i) => `${i + 1}. ${tab.title || '(untitled)'}\n   ${tab.url || ''}`);
        return { ok: true, text: lines.join('\n') };
    }
    if (sub !== 'status') return { ok: false, text: 'Usage: /browser [status|tabs]' };
    const d = await ctx.getBrowserStatus();
    const running = d?.running ? 'running' : 'stopped';
    const tabCount = d?.tabs?.length ?? d?.tabCount ?? '-';
    return { ok: true, text: `🌐 Browser: ${running}\nTabs: ${tabCount}\nCDP: ${d?.cdpUrl || '-'}` };
}

export async function promptHandler(_args, ctx) {
    const d = await ctx.getPrompt();
    const content = d?.content || '';
    if (!content.trim()) return { ok: true, text: '(empty prompt)' };
    const lines = content.trim().split('\n');
    const preview = lines.slice(0, 20).join('\n');
    const suffix = lines.length > 20 ? '\n...(truncated)' : '';
    return { ok: true, text: `${preview}${suffix}` };
}

export async function quitHandler() {
    return { ok: true, code: 'exit', text: 'Bye!' };
}

export async function fileHandler() {
    return { ok: false, text: 'Usage: /file <path> [caption]' };
}

export async function fallbackHandler(args, ctx) {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };
    const available = Object.keys(settings.perCli || {});

    if (!args.length) {
        const fb = settings.fallbackOrder || [];
        return {
            ok: true, type: 'info',
            text: fb.length
                ? `⚡ Fallback: ${fb.join(' → ')}`
                : t('cmd.fallback.inactive', { available: available.join(', ') }, L),
        };
    }

    if (args[0] === 'off' || args[0] === 'none') {
        const r = await ctx.updateSettings({ fallbackOrder: [] });
        if (r?.ok === false) return r;
        return { ok: true, text: t('cmd.fallback.off', {}, L) };
    }

    const order = args.filter(a => available.includes(a.toLowerCase())).map(a => a.toLowerCase());
    if (!order.length) {
        return { ok: false, text: t('cmd.fallback.invalidCli', { available: available.join(', ') }, L) };
    }

    const r = await ctx.updateSettings({ fallbackOrder: order });
    if (r?.ok === false) return r;
    return { ok: true, text: t('cmd.fallback.set', { order: order.join(' → ') }, L) };
}

// ─── Argument Completions ────────────────────────────

export function modelArgumentCompletions(ctx) {
    const cliByModel = new Map();
    for (const [cli, models] of Object.entries(MODEL_CHOICES_BY_CLI)) {
        for (const m of models) cliByModel.set(toChoiceKey(m), cli);
    }

    return getModelChoicesFromContext(ctx)
        .map(value => ({
            value,
            label: cliByModel.get(toChoiceKey(value)) || 'custom',
        }));
}

export function cliArgumentCompletions(ctx) {
    return getCliChoicesFromContext(ctx)
        .map(value => ({ value, label: 'cli' }));
}

export function skillArgumentCompletions(ctx) {
    const L = ctx?.locale || 'ko';
    return [{ value: 'list', label: t('cmd.arg.skillList', {}, L) }, { value: 'reset', label: t('cmd.arg.skillReset', {}, L) }];
}

export function employeeArgumentCompletions(ctx) {
    const L = ctx?.locale || 'ko';
    return [{ value: 'reset', label: t('cmd.arg.employeeReset', {}, L) }];
}

export function browserArgumentCompletions(ctx) {
    const L = ctx?.locale || 'ko';
    return [{ value: 'status', label: t('cmd.arg.browserStatus', {}, L) }, { value: 'tabs', label: t('cmd.arg.browserTabs', {}, L) }];
}

export function fallbackArgumentCompletions(ctx) {
    const L = ctx?.locale || 'ko';
    const clis = Object.keys(ctx?.settings?.perCli || {});
    return [
        ...clis.map(c => ({ value: c, label: 'cli' })),
        { value: 'off', label: t('cmd.arg.fallbackOff', {}, L) },
    ];
}
