// ─── Slash Commands Registry + Dispatcher ───────────────────────────────

const CATEGORY_ORDER = ['session', 'model', 'tools', 'cli'];
const CATEGORY_LABEL = {
    session: 'Session',
    model: 'Model',
    tools: 'Tools',
    cli: 'CLI',
};
const DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini', 'opencode'];
const MODEL_CHOICES_BY_CLI = {
    claude: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-4-6[1m]', 'claude-opus-4-6[1m]', 'claude-haiku-4-5-20251001'],
    codex: ['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'],
    gemini: ['gemini-3.0-pro-preview', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    opencode: [
        'github-copilot/claude-sonnet-4.5', 'github-copilot/claude-opus-4.6',
        'github-copilot/gpt-5', 'github-copilot/gemini-2.5-pro',
        'opencode/big-pickle', 'opencode/GLM-5 Free', 'opencode/MiniMax M2.5 Free',
        'opencode/Kimi K2.5 Free', 'opencode/GPT 5 Nano Free', 'opencode/Grok Code Fast 1 Free',
    ],
};

function sortCommands(list) {
    return [...list].sort((a, b) => {
        const ai = CATEGORY_ORDER.indexOf(a.category || 'tools');
        const bi = CATEGORY_ORDER.indexOf(b.category || 'tools');
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
    });
}

function displayUsage(cmd) {
    return `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}`;
}

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

function normalizeArgumentCandidate(entry) {
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

function scoreToken(value, query) {
    const target = toChoiceKey(value);
    const q = toChoiceKey(query);
    if (!q) return 0;
    if (!target) return -1;
    if (target === q) return 100;
    if (target.startsWith(q)) return 60;
    if (target.includes(q)) return 30;
    return -1;
}

function categoryIndex(category) {
    const idx = CATEGORY_ORDER.indexOf(category || 'tools');
    return idx >= 0 ? idx : CATEGORY_ORDER.length;
}

function scoreCommandCandidate(cmd, query) {
    const q = toChoiceKey(query);
    if (!q) return 0;

    let score = scoreToken(cmd.name, q);
    for (const alias of (cmd.aliases || [])) {
        const aliasScore = scoreToken(alias, q);
        if (aliasScore > score) score = aliasScore - 5; // alias는 name보다 낮게 우선
    }
    return score;
}

function scoreArgumentCandidate(item, query) {
    const base = scoreToken(item.value, query);
    if (base >= 0) return base;
    const labelScore = scoreToken(item.label, query);
    if (labelScore >= 0) return Math.max(10, labelScore - 10);
    return -1;
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

function modelArgumentCompletions(ctx) {
    // CLI별 라벨 역매핑: model → CLI name
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

function cliArgumentCompletions(ctx) {
    return getCliChoicesFromContext(ctx)
        .map(value => ({ value, label: 'cli' }));
}

function skillArgumentCompletions() {
    return [{ value: 'list', label: '스킬 목록' }, { value: 'reset', label: '스킬 초기화' }];
}

function employeeArgumentCompletions() {
    return [{ value: 'reset', label: '기본 5명 재생성' }];
}

function browserArgumentCompletions() {
    return [{ value: 'status', label: '브라우저 상태' }, { value: 'tabs', label: '열린 탭 목록' }];
}

function findCommand(name) {
    const key = (name || '').toLowerCase();
    return COMMANDS.find(c => c.name === key || (c.aliases || []).includes(key));
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

function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function normalizeResult(result) {
    if (!result) return { ok: true, type: 'success', text: '' };
    if (typeof result === 'string') return { ok: true, type: 'info', text: result };
    if (typeof result === 'object') {
        const ok = result.ok !== false;
        const type = result.type || (ok ? 'success' : 'error');
        return { ok, type, ...result };
    }
    return { ok: true, type: 'info', text: String(result) };
}

function unknownCommand(name) {
    return {
        ok: false,
        type: 'error',
        code: 'unknown_command',
        text: `알 수 없는 커맨드: /${name}\n/help로 사용 가능한 커맨드를 확인하세요.`,
    };
}

function unsupportedCommand(cmd, iface) {
    return {
        ok: false,
        type: 'error',
        code: 'unsupported_interface',
        text: `❌ /${cmd.name}은(는) ${iface}에서 사용할 수 없습니다.`,
    };
}

async function helpHandler(args, ctx) {
    const iface = ctx.interface || 'cli';
    if (args[0]) {
        const targetName = String(args[0]).replace(/^\//, '');
        const target = findCommand(targetName);
        if (!target) return unknownCommand(targetName);
        const lines = [
            `${displayUsage(target)} — ${target.desc}`,
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

    const lines = ['사용 가능한 커맨드'];
    for (const cat of CATEGORY_ORDER) {
        const cmds = byCategory.get(cat);
        if (!cmds?.length) continue;
        lines.push(`\n[${CATEGORY_LABEL[cat] || cat}]`);
        for (const cmd of cmds) {
            lines.push(`- ${displayUsage(cmd)} — ${cmd.desc}`);
        }
    }
    lines.push('\n상세 도움말: /help <command>');
    return { ok: true, type: 'info', text: lines.join('\n') };
}

async function statusHandler(_args, ctx) {
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

async function modelHandler(args, ctx) {
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: '❌ 설정을 불러올 수 없습니다.' };

    const activeCli = settings.cli || 'claude';
    const current = settings.perCli?.[activeCli]?.model || 'default';

    if (!args.length) {
        return { ok: true, text: `현재 모델(${activeCli}): ${current}` };
    }

    const nextModel = args.join(' ').trim();
    if (!nextModel || nextModel.length > 200 || /[\r\n]/.test(nextModel)) {
        return { ok: false, text: '❌ 유효하지 않은 모델 이름입니다.' };
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
        text: `✅ 모델 변경: ${nextModel}\n다음 메시지부터 적용됩니다.`,
    };
}

async function cliHandler(args, ctx) {
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: '❌ 설정을 불러올 수 없습니다.' };

    const allowed = Object.keys(settings.perCli || {});
    const fallbackAllowed = allowed.length ? allowed : ['claude', 'codex', 'gemini', 'opencode'];
    const current = settings.cli || 'claude';

    if (!args.length) {
        return {
            ok: true,
            text: `현재 CLI: ${current}\n사용 가능: ${fallbackAllowed.join(', ')}`,
        };
    }

    const nextCli = args[0].toLowerCase();
    if (!fallbackAllowed.includes(nextCli)) {
        return {
            ok: false,
            text: `❌ 알 수 없는 CLI: ${nextCli}\n사용 가능: ${fallbackAllowed.join(', ')}`,
        };
    }

    if (nextCli === current) {
        return { ok: true, text: `이미 ${nextCli}가 활성화되어 있습니다.` };
    }

    const updateResult = await ctx.updateSettings({ cli: nextCli });
    if (updateResult?.ok === false) return updateResult;
    return { ok: true, text: `✅ CLI 변경: ${current} → ${nextCli}` };
}

async function skillHandler(args, ctx) {
    const sub = (args[0] || 'list').toLowerCase();
    if (sub === 'list') {
        const skills = await safeCall(ctx.getSkills, []);
        if (!Array.isArray(skills)) return { ok: false, text: '❌ 스킬 정보를 불러올 수 없습니다.' };
        const active = skills.filter(s => s.enabled).length;
        const ref = skills.filter(s => !s.enabled).length;
        return { ok: true, text: `🧰 Skills: ${active} active, ${ref} ref` };
    }
    if (sub === 'reset') {
        if (typeof ctx.resetSkills !== 'function') {
            return { ok: false, text: '❌ 이 환경에서는 /skill reset을 사용할 수 없습니다.' };
        }
        await ctx.resetSkills();
        return { ok: true, text: '✅ 스킬 초기화를 실행했습니다.' };
    }
    return { ok: false, text: 'Usage: /skill [list|reset]' };
}

async function employeeHandler(args, ctx) {
    const sub = (args[0] || '').toLowerCase();
    if (sub !== 'reset') {
        return { ok: false, text: 'Usage: /employee reset' };
    }
    if (typeof ctx.resetEmployees !== 'function') {
        return { ok: false, text: '❌ 이 환경에서는 /employee reset을 사용할 수 없습니다.' };
    }
    const result = await ctx.resetEmployees();
    const seeded = Number.isFinite(result?.seeded) ? result.seeded : '?';
    return { ok: true, text: `✅ 직원 기본값으로 재설정 완료 (${seeded}명)` };
}

async function clearHandler(_args, ctx) {
    if ((ctx.interface || 'cli') === 'telegram') {
        return { ok: true, text: 'ℹ️ Telegram에서는 /clear가 화면 정리 없이 안내만 합니다.' };
    }
    return {
        ok: true,
        code: 'clear_screen',
        text: '✅ 화면을 정리했습니다. (대화 기록은 유지됨)',
    };
}

async function resetHandler(args, ctx) {
    if ((args[0] || '').toLowerCase() !== 'confirm') {
        return {
            ok: false,
            text: '⚠️ 전체 초기화: MCP, 스킬, 직원, 세션을 기본값으로 재설정합니다.\n실행하려면 /reset confirm 을 입력하세요.',
        };
    }
    const results = [];
    if (typeof ctx.resetSkills === 'function') {
        await ctx.resetSkills();
        results.push('스킬');
    }
    if (typeof ctx.resetEmployees === 'function') {
        await ctx.resetEmployees();
        results.push('직원');
    }
    if (typeof ctx.syncMcp === 'function') {
        await ctx.syncMcp();
        results.push('MCP');
    }
    if (typeof ctx.clearSession === 'function') {
        await ctx.clearSession();
        results.push('세션');
    }
    if (!results.length) {
        return { ok: false, text: '❌ 이 환경에서는 초기화가 지원되지 않습니다.' };
    }
    return { ok: true, text: `✅ 초기화 완료: ${results.join(', ')}` };
}

async function versionHandler(_args, ctx) {
    const status = await safeCall(ctx.getCliStatus, null);
    const lines = [`cli-claw v${ctx.version || 'unknown'}`];
    if (status && typeof status === 'object') {
        for (const key of ['claude', 'codex', 'gemini', 'opencode']) {
            if (!status[key]) continue;
            const entry = status[key];
            const icon = entry.available ? '✅' : '❌';
            lines.push(`${key}: ${icon}${entry.path ? ` ${entry.path}` : ''}`);
        }
    }
    return { ok: true, text: lines.join('\n') };
}

async function mcpHandler(args, ctx) {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'sync') {
        const d = await ctx.syncMcp();
        const keys = Object.keys(d?.results || {});
        return { ok: true, text: `✅ MCP sync 완료 (${keys.length} target)` };
    }
    if (sub === 'install') {
        const d = await ctx.installMcp();
        const keys = Object.keys(d?.results || {});
        return { ok: true, text: `✅ MCP install 완료 (${keys.length} server)` };
    }
    const d = await ctx.getMcp();
    const names = Object.keys(d?.servers || {});
    return {
        ok: true,
        text: `MCP servers (${names.length}): ${names.join(', ') || '(none)'}\n/mcp sync\n/mcp install`,
    };
}

async function memoryHandler(args, ctx) {
    if (!args.length || (args.length === 1 && args[0].toLowerCase() === 'list')) {
        const files = await ctx.listMemory();
        if (!files?.length) return { ok: true, text: '🧠 memory 파일이 없습니다.' };
        const lines = files.slice(0, 20).map(f => `- ${f.path} (${f.size}b)`);
        return { ok: true, text: `🧠 memory files (${files.length})\n${lines.join('\n')}` };
    }
    const query = args.join(' ').trim();
    const result = await ctx.searchMemory(query);
    const text = String(result || '(no results)');
    const MAX = 3000;
    return { ok: true, text: text.length > MAX ? text.slice(0, MAX) + '\n...(truncated)' : text };
}

async function browserHandler(args, ctx) {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'tabs') {
        const d = await ctx.getBrowserTabs();
        const tabs = d?.tabs || [];
        if (!tabs.length) return { ok: true, text: '🌐 열린 탭이 없습니다.' };
        const lines = tabs.slice(0, 10).map((t, i) => `${i + 1}. ${t.title || '(untitled)'}\n   ${t.url || ''}`);
        return { ok: true, text: lines.join('\n') };
    }
    if (sub !== 'status') return { ok: false, text: 'Usage: /browser [status|tabs]' };
    const d = await ctx.getBrowserStatus();
    const running = d?.running ? 'running' : 'stopped';
    const tabCount = d?.tabs?.length ?? d?.tabCount ?? '-';
    return { ok: true, text: `🌐 Browser: ${running}\nTabs: ${tabCount}\nCDP: ${d?.cdpUrl || '-'}` };
}

async function promptHandler(_args, ctx) {
    const d = await ctx.getPrompt();
    const content = d?.content || '';
    if (!content.trim()) return { ok: true, text: '(empty prompt)' };
    const lines = content.trim().split('\n');
    const preview = lines.slice(0, 20).join('\n');
    const suffix = lines.length > 20 ? '\n...(truncated)' : '';
    return { ok: true, text: `${preview}${suffix}` };
}

async function quitHandler() {
    return { ok: true, code: 'exit', text: 'Bye!' };
}

async function fileHandler() {
    return { ok: false, text: 'Usage: /file <path> [caption]' };
}

async function fallbackHandler(args, ctx) {
    const settings = await safeCall(ctx.getSettings, null);
    if (!settings) return { ok: false, text: '❌ 설정을 불러올 수 없습니다.' };
    const available = Object.keys(settings.perCli || {});

    if (!args.length) {
        const fb = settings.fallbackOrder || [];
        return {
            ok: true, type: 'info',
            text: fb.length
                ? `⚡ Fallback: ${fb.join(' → ')}`
                : `⚡ Fallback: 비활성화\n사용 가능: ${available.join(', ')}`,
        };
    }

    if (args[0] === 'off' || args[0] === 'none') {
        const r = await ctx.updateSettings({ fallbackOrder: [] });
        if (r?.ok === false) return r;
        return { ok: true, text: '⚡ Fallback 비활성화됨' };
    }

    const order = args.filter(a => available.includes(a.toLowerCase())).map(a => a.toLowerCase());
    if (!order.length) {
        return { ok: false, text: `❌ 유효한 CLI 없음\n사용 가능: ${available.join(', ')}` };
    }

    const r = await ctx.updateSettings({ fallbackOrder: order });
    if (r?.ok === false) return r;
    return { ok: true, text: `⚡ Fallback 설정: ${order.join(' → ')}` };
}

function fallbackArgumentCompletions(ctx) {
    const clis = Object.keys(ctx?.settings?.perCli || {});
    return [
        ...clis.map(c => ({ value: c, label: 'cli' })),
        { value: 'off', label: '비활성화' },
    ];
}

export const COMMANDS = [
    { name: 'help', aliases: ['h'], desc: '커맨드 목록', args: '[command]', category: 'session', interfaces: ['cli', 'web', 'telegram'], handler: helpHandler },
    { name: 'status', desc: '현재 상태', category: 'session', interfaces: ['cli', 'web', 'telegram'], handler: statusHandler },
    { name: 'clear', desc: '화면 정리 (비파괴)', category: 'session', interfaces: ['cli', 'web', 'telegram'], handler: clearHandler },
    { name: 'reset', desc: '전체 초기화 (MCP/스킬/직원/세션)', args: '[confirm]', category: 'session', interfaces: ['cli', 'web'], handler: resetHandler },
    { name: 'model', desc: '모델 확인/변경', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: modelArgumentCompletions, handler: modelHandler },
    { name: 'cli', desc: '활성 CLI 확인/변경', args: '[name]', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: cliArgumentCompletions, handler: cliHandler },
    { name: 'fallback', desc: '폴백 CLI 순서 설정', args: '[cli1 cli2...|off]', category: 'model', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: fallbackArgumentCompletions, handler: fallbackHandler },
    { name: 'version', desc: '버전/CLI 설치 상태', category: 'cli', interfaces: ['cli', 'web', 'telegram'], handler: versionHandler },
    { name: 'skill', desc: '스킬 목록/초기화', args: '[list|reset]', category: 'tools', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: skillArgumentCompletions, handler: skillHandler },
    { name: 'employee', desc: '직원 기본값 재설정', args: 'reset', category: 'tools', interfaces: ['cli', 'web'], getArgumentCompletions: employeeArgumentCompletions, handler: employeeHandler },
    { name: 'mcp', desc: 'MCP 목록/동기화/설치', args: '[sync|install]', category: 'tools', interfaces: ['cli', 'web'], handler: mcpHandler },
    { name: 'memory', desc: '메모리 검색/목록', args: '[query]', category: 'tools', interfaces: ['cli'], handler: memoryHandler },
    { name: 'browser', desc: '브라우저 상태/탭', args: '[status|tabs]', category: 'tools', interfaces: ['cli', 'web', 'telegram'], getArgumentCompletions: browserArgumentCompletions, handler: browserHandler },
    { name: 'prompt', desc: '시스템 프롬프트 확인', category: 'tools', interfaces: ['cli', 'web'], handler: promptHandler },
    { name: 'quit', aliases: ['q', 'exit'], desc: '프로세스 종료', category: 'cli', interfaces: ['cli'], handler: quitHandler },
    { name: 'file', desc: '파일 첨부', args: '<path> [caption]', category: 'cli', interfaces: ['cli'], hidden: true, handler: fileHandler },
];

export function parseCommand(text) {
    if (typeof text !== 'string' || !text.startsWith('/')) return null;
    const body = text.slice(1).trim();
    if (!body) {
        const help = findCommand('help');
        return { type: 'known', cmd: help, args: [], name: 'help' };
    }
    const parts = body.split(/\s+/);
    const name = (parts.shift() || '').toLowerCase();
    const cmd = findCommand(name);
    if (!cmd) return { type: 'unknown', name, args: parts };
    return { type: 'known', cmd, args: parts, name };
}

export async function executeCommand(parsed, ctx) {
    if (!parsed) return null;
    if (parsed.type === 'unknown') return unknownCommand(parsed.name);
    if (!parsed.cmd.interfaces.includes(ctx.interface || 'cli')) {
        return unsupportedCommand(parsed.cmd, ctx.interface || 'cli');
    }
    try {
        return normalizeResult(await parsed.cmd.handler(parsed.args || [], ctx));
    } catch (err) {
        const msg = err?.message || String(err);
        return {
            ok: false,
            code: 'command_error',
            text: `❌ /${parsed.cmd.name} 실행 오류: ${msg}`,
        };
    }
}

export function getCompletions(partial, iface = 'cli') {
    const prefix = (partial || '').startsWith('/')
        ? (partial || '').toLowerCase()
        : '/' + String(partial || '').toLowerCase();
    return getCompletionItems(prefix, iface)
        .map(c => `/${c.name}`);
}

export function getCompletionItems(partial, iface = 'cli') {
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
            desc: cmd.desc,
            args: cmd.args || '',
            category: cmd.category || 'tools',
            insertText: `/${cmd.name}${cmd.args ? ' ' : ''}`,
        }));
}

export function getArgumentCompletionItems(commandName, partial = '', iface = 'cli', argv = [], ctx = {}) {
    const cmd = findCommand(commandName);
    if (!cmd || cmd.hidden) return [];
    if (!cmd.interfaces.includes(iface)) return [];
    if (typeof cmd.getArgumentCompletions !== 'function') return [];

    let candidates;
    try {
        candidates = cmd.getArgumentCompletions(ctx, argv, partial) || [];
    } catch (err) {
        if (process.env.DEBUG) console.warn('[commands:argComplete]', err.message);
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
