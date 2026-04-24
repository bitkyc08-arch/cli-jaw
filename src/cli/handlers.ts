// ─── Slash Command Handlers ─────────────────────────
// Extracted from commands.js for 500-line compliance.

import { CLI_KEYS, buildModelChoicesByCli } from './registry.js';
import { t } from '../core/i18n.js';
import { detectCli, settings } from '../core/config.js';
export { compactHandler } from './compact.js';

const DEFAULT_CLI_CHOICES = [...CLI_KEYS];
const MODEL_CHOICES_BY_CLI = buildModelChoicesByCli();

function toChoiceKey(value: any) {
    return String(value || '').trim().toLowerCase();
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

function getCliChoicesFromContext(ctx: any) {
    const keys = Object.keys(ctx?.settings?.perCli || {});
    return keys.length ? keys : DEFAULT_CLI_CHOICES;
}

function getModelChoicesFromContext(ctx: any) {
    const fromCatalog = Object.values(MODEL_CHOICES_BY_CLI).flat();
    const fromSettings = Object.values(ctx?.settings?.perCli || {} as Record<string, any>)
        .map((v: any) => v?.model)
        .filter(Boolean);
    const activeCli = ctx?.settings?.cli || '';
    const currentModel = ctx?.settings?.perCli?.[activeCli]?.model;
    return dedupeChoices([...fromCatalog, ...fromSettings, ...(currentModel ? [currentModel] : [])]);
}

async function safeCall(fn: any, fallback: any = null) {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch (err: unknown) {
        if (process.env.DEBUG) console.warn('[commands:safeCall]', (err as Error).message);
        return fallback;
    }
}

export function formatDuration(seconds: any) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function unknownCommand(name: any, locale = 'ko') {
    return {
        ok: false,
        type: 'error',
        code: 'unknown_command',
        text: t('cmd.unknown', { name }, locale),
    };
}

export function unsupportedCommand(cmd: any, iface: any, locale = 'ko') {
    return {
        ok: false,
        type: 'error',
        code: 'unsupported_interface',
        text: t('cmd.unsupported', { name: cmd.name, iface }, locale),
    };
}

export function normalizeResult(result: any) {
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

export async function statusHandler(_args: any[], ctx: any) {
    const [settings, session, runtime, skills] = await Promise.all([
        safeCall(ctx.getSettings, null),
        safeCall(ctx.getSession, null),
        safeCall(ctx.getRuntime, null),
        safeCall(ctx.getSkills, null),
    ]);

    const cli = settings?.cli || session?.active_cli || 'unknown';
    const overrideModel = settings?.activeOverrides?.[cli]?.model;
    const sessionCli = session?.active_cli || session?.activeCli;
    const sessionModel = session?.model && (!sessionCli || sessionCli === cli)
        ? session.model
        : undefined;
    const model = overrideModel
        || sessionModel
        || settings?.perCli?.[cli]?.model
        || 'default';
    const overrideEffort = settings?.activeOverrides?.[cli]?.effort;
    const sessionEffort = session?.effort && (!sessionCli || sessionCli === cli)
        ? session.effort
        : undefined;
    const effort = overrideEffort
        || sessionEffort
        || settings?.perCli?.[cli]?.effort
        || '-';
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
            `🦈 cli-jaw v${ctx.version || 'unknown'}`,
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

export async function modelHandler(args: any[], ctx: any) {
    const L = ctx.locale || 'ko';
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, L) };

    const activeCli = settings.cli || 'claude';
    const session = await safeCall(ctx.getSession, null);
    const sessionCli = session?.active_cli || session?.activeCli;
    const overrideModel = settings.activeOverrides?.[activeCli]?.model;
    const sessionModel = session?.model && (!sessionCli || sessionCli === activeCli)
        ? session.model
        : undefined;
    const current = overrideModel
        || sessionModel
        || settings.perCli?.[activeCli]?.model
        || 'default';

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

export async function cliHandler(args: any[], ctx: any) {
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

export async function thoughtHandler(args: any[], ctx: any) {
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: t('cmd.settingsLoadFail', {}, ctx.locale || 'ko') };

    const sub = String(args[0] || '').toLowerCase();
    if (!sub || sub === 'status') {
        return {
            ok: true,
            text: `Gemini thought visibility: ${settings.showReasoning === true ? 'ON' : 'OFF'}\nUsage: /thought on|off`,
        };
    }
    if (sub !== 'on' && sub !== 'off') {
        return { ok: false, text: 'Usage: /thought on|off' };
    }

    const next = sub === 'on';
    const updateResult = await ctx.updateSettings({ showReasoning: next });
    if (updateResult?.ok === false) return updateResult;
    return { ok: true, text: `Gemini thought visibility: ${next ? 'ON' : 'OFF'}` };
}

export async function skillHandler(args: any[], ctx: any) {
    const L = ctx.locale || 'ko';
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
        const skills = await safeCall(ctx.getSkills, null);
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

export async function employeeHandler(args: any[], ctx: any) {
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

export async function clearHandler(_args: any[], ctx: any) {
    const L = ctx.locale || 'ko';
    const iface = ctx.interface || 'cli';

    if (typeof ctx.clearSession === 'function') {
        await ctx.clearSession();
    }

    if (iface === 'telegram' || iface === 'discord') {
        return { ok: true, text: t('cmd.clear.remote', {}, L) };
    }
    return {
        ok: true,
        code: 'clear_screen',
        text: t('cmd.clear.done', {}, L),
    };
}

export async function resetHandler(args: any[], ctx: any) {
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
    if (typeof ctx.resetSession === 'function') {
        await ctx.resetSession();
        results.push(t('cmd.reset.sessions', {}, L));
    }
    if (!results.length) {
        return { ok: false, text: t('cmd.reset.unavailable', {}, L) };
    }
    return { ok: true, text: t('cmd.reset.done', { items: results.join(', ') }, L) };
}

export async function versionHandler(_args: any[], ctx: any) {
    const status = await safeCall(ctx.getCliStatus, null);
    const lines = [`cli-jaw v${ctx.version || 'unknown'}`];
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

export async function mcpHandler(args: any[], ctx: any) {
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

// Re-exports for backward compatibility
export { memoryHandler, browserHandler, promptHandler, quitHandler, fileHandler, steerHandler, forwardHandler, fallbackHandler, flushHandler, ideHandler, orchestrateHandler } from './handlers-runtime.js';
export { modelArgumentCompletions, cliArgumentCompletions, skillArgumentCompletions, employeeArgumentCompletions, browserArgumentCompletions, fallbackArgumentCompletions, flushArgumentCompletions } from './handlers-completions.js';
