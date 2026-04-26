// ─── Compact Helpers ────────────────────────────────

export const COMPACT_MARKER_CONTENT = 'Conversation compacted.';
export const MANAGED_COMPACT_PREFIX = '[assistant] Managed compact summary:';
// Phase 52: Bootstrap trace prefix (declared early so isCompactMarkerRow can OR-match).
// The full bootstrap payload writer below references the same constant.
export const BOOTSTRAP_TRACE_PREFIX = '[assistant] Bootstrap compact payload:';

type MessageRow = {
    role?: string | null;
    content?: string | null;
    trace?: string | null;
    model?: string | null;
};

function safeText(value: unknown): string {
    return String(value || '').trim();
}

function normalizeSummaryText(text: string): string {
    return text
        .replace(/<\/?tool_call>/g, '')
        .replace(/<\/?tool_result>[\s\S]*?(?:<\/tool_result>|$)/g, '')
        .replace(/\n\n✅[\s\S]*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function clipText(text: string, max = 220): string {
    const normalized = normalizeSummaryText(text);
    if (!normalized) return '';
    return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

export function isCompactMarkerRow(row: MessageRow | null | undefined): boolean {
    if (!row) return false;
    const role = safeText(row.role);
    const content = safeText(row.content);
    const trace = safeText(row.trace);
    // Phase 52: accept both managed-compact and bootstrap-compact prefixes.
    // Content guard MUST stay so bootstrap rows that lack COMPACT_MARKER_CONTENT
    // are not falsely treated as boundaries.
    return role === 'assistant'
        && content === COMPACT_MARKER_CONTENT
        && (trace.startsWith(MANAGED_COMPACT_PREFIX) || trace.startsWith(BOOTSTRAP_TRACE_PREFIX));
}

export function getRowsSinceLatestCompactForTest(rows: MessageRow[]): MessageRow[] {
    const selected: MessageRow[] = [];
    for (const row of rows || []) {
        if (isCompactMarkerRow(row)) break;
        selected.push(row);
    }
    return selected.reverse();
}

function formatSummaryLine(row: MessageRow): string {
    const role = safeText(row.role) || 'user';
    const primary = role === 'assistant'
        ? safeText(row.content) || safeText(row.trace)
        : safeText(row.content);
    const clipped = clipText(primary);
    if (!clipped) return '';
    return `- [${role}] ${clipped}`;
}

export function buildManagedCompactSummaryForTest(rows: MessageRow[], instructions = ''): string {
    const windowRows = getRowsSinceLatestCompactForTest(rows)
        .filter(row => safeText(row.role) === 'user' || safeText(row.role) === 'assistant')
        .slice(-8);
    const lines = [
        MANAGED_COMPACT_PREFIX,
        `focus instructions: ${safeText(instructions) || 'Preserve the active task, latest decisions, blockers, and next steps.'}`,
        'keep only these facts:',
    ];

    for (const row of windowRows) {
        const line = formatSummaryLine(row);
        if (line) lines.push(line);
    }

    if (lines.length === 3) {
        lines.push('- No recent user/assistant turns were available. Preserve only the latest compact state.');
    }
    lines.push('discard everything else.');
    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Bootstrap compact (vendor-agnostic, session-reset model)
// ─────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { getRecentMessages } from './db.js';
import { searchMemoryWithPolicy } from '../memory/injection.js';
import { buildTaskSnapshot } from '../memory/runtime.js';

// BOOTSTRAP_TRACE_PREFIX is now declared at the top alongside MANAGED_COMPACT_PREFIX (Phase 52).

export const BOOTSTRAP_BUDGET = {
    goal: 500,
    recent_turns: 4000,
    memory_hits: 2000,
    grep_hits: 1500,
    task_snapshot: 2000,
    total_max: 10_000,
} as const;

export type BootstrapSlots = {
    goal: string;
    recent_turns: string;
    memory_hits: string;
    grep_hits: string;
    task_snapshot: string;
};

export type HarvestInput = {
    workingDir: string | null;
    instructions: string;
};

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'to', 'of', 'in', 'on', 'for',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'it',
    'with', 'by', 'as', 'at', 'from', 'into', 'not', 'no', 'do', 'does', 'did',
    'i', 'you', 'we', 'they', 'he', 'she', 'me', 'my', 'your', 'our', 'their',
]);

const MEMORY_SEARCH_SENTINELS = new Set(['(no results)', '(query required)']);

function extractKeywords(text: string, limit: number): string[] {
    const freq = new Map<string, number>();
    const tokens = (text || '')
        .toLowerCase()
        .replace(/[`*_~#>()\[\]{}'".,!?;:/\\]/g, ' ')
        .split(/\s+/)
        .filter(tok => tok.length >= 3 && !STOPWORDS.has(tok) && !/^\d+$/.test(tok));
    for (const tok of tokens) freq.set(tok, (freq.get(tok) || 0) + 1);
    return [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tok]) => tok);
}

function clipSlot(text: string, max: number): string {
    const trimmed = (text || '').trim();
    if (!trimmed) return '';
    if (trimmed.length <= max) return trimmed;
    return trimmed.slice(0, max - 1).trimEnd() + '…';
}

export function normalizeWorkingDir(wd: string | null | undefined): string | null {
    if (!wd || wd === '~') return null;
    if (wd.startsWith('~/')) return wd.replace(/^~/, homedir());
    return wd;
}

function harvestGoal(rows: MessageRow[], instructions: string): string {
    const raw = safeText(instructions);
    if (raw) return clipSlot(raw, BOOTSTRAP_BUDGET.goal);
    const lastUser = [...rows].reverse().find(r => safeText(r.role) === 'user');
    const fallback = lastUser ? safeText(lastUser.content) : '';
    if (fallback) return clipSlot(fallback, BOOTSTRAP_BUDGET.goal);
    return 'Continue the task.';
}

function harvestRecentTurns(rows: MessageRow[]): string {
    const windowRows = getRowsSinceLatestCompactForTest(rows)
        .filter(r => {
            const role = safeText(r.role);
            return role === 'user' || role === 'assistant';
        })
        .slice(-10);
    const lines: string[] = [];
    const totalRows = windowRows.length;
    for (let i = 0; i < totalRows; i++) {
        const row = windowRows[i]!;
        const role = safeText(row.role) || 'user';
        const body = role === 'assistant'
            ? safeText(row.content) || safeText(row.trace)
            : safeText(row.content);
        // Phase 53-C: Last 3 turns get 800 char budget to preserve recent agreements;
        // older turns get 600 (up from 380) for better context.
        const charLimit = (totalRows - i) <= 3 ? 800 : 600;
        const clipped = clipSlot(normalizeSummaryText(body), charLimit);
        if (clipped) lines.push(`- [${role}] ${clipped}`);
    }
    let joined = lines.join('\n');
    while (joined.length > BOOTSTRAP_BUDGET.recent_turns && lines.length > 1) {
        lines.shift();
        joined = lines.join('\n');
    }
    return joined;
}

function harvestMemoryHits(goal: string, recentBody: string): string {
    try {
        const keywords = extractKeywords(`${goal} ${recentBody}`, 6);
        if (!keywords.length) return '';
        const query = keywords.join(' ');
        const raw = searchMemoryWithPolicy({ query, role: 'boss' });
        const text = String(raw || '').trim();
        if (!text || MEMORY_SEARCH_SENTINELS.has(text) || text.startsWith('(search error:')) return '';
        return clipSlot(text, BOOTSTRAP_BUDGET.memory_hits);
    } catch {
        return '';
    }
}

function harvestGrepHits(goal: string, workingDir: string | null): string {
    if (!workingDir) return '';
    const keywords = extractKeywords(goal, 3);
    if (!keywords.length) return '';
    const lines: string[] = [];
    for (const kw of keywords) {
        try {
            const out = execFileSync('git', [
                '-C', workingDir,
                'grep', '-n', '--untracked', '-I', '--max-count=5', '-e', kw,
            ], { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] });
            for (const raw of out.split('\n')) {
                if (!raw.trim()) continue;
                const m = raw.match(/^([^:]+):(\d+):(.*)$/);
                if (!m) continue;
                const file = m[1] || '';
                const line = m[2] || '';
                const snippet = m[3] || '';
                if (!file || file.includes('node_modules/') || file.startsWith('.git/')) continue;
                lines.push(`- ${file}:${line} ${snippet.trim().slice(0, 120)}`);
                if (lines.length >= 10) break;
            }
            if (lines.length >= 10) break;
        } catch {
            // keyword miss or git not available — skip
        }
    }
    let joined = lines.join('\n');
    while (joined.length > BOOTSTRAP_BUDGET.grep_hits && lines.length > 1) {
        lines.pop();
        joined = lines.join('\n');
    }
    return joined;
}

function harvestTaskSnapshot(goal: string): string {
    try {
        const snap = buildTaskSnapshot(goal, BOOTSTRAP_BUDGET.task_snapshot);
        return clipSlot(String(snap || ''), BOOTSTRAP_BUDGET.task_snapshot);
    } catch {
        return '';
    }
}

export function harvestBootstrapSlots(input: HarvestInput): BootstrapSlots {
    const wd = normalizeWorkingDir(input.workingDir);
    const rows = (getRecentMessages.all(wd, 40) as MessageRow[]) || [];
    const goal = harvestGoal(rows, input.instructions);
    const recent_turns = harvestRecentTurns(rows);
    const memory_hits = harvestMemoryHits(goal, recent_turns);
    const grep_hits = harvestGrepHits(goal, wd);
    const task_snapshot = harvestTaskSnapshot(goal);
    return { goal, recent_turns, memory_hits, grep_hits, task_snapshot };
}

// CLI-switch refresh: when settings.cli changes, harvest the prior conversation
// from sourceWorkDir, persist a bootstrap handoff for the next spawn, clear the
// target CLI's session bucket so spawn.ts doesn't resume a stale per-CLI session,
// and broadcast a notice. All four DB ops run in a single better-sqlite3
// transaction so any failure rolls back atomically — the caller (runtime-settings)
// then reverts the settings file, leaving DB and config consistent.
export async function cliSwitchRefresh(opts: {
    sourceWorkDir: string;
    targetWorkDir: string;
    fromCli: string;
    toCli: string;
    toModel: string;
}): Promise<{ refreshed: boolean }> {
    const slots = harvestBootstrapSlots({ workingDir: opts.sourceWorkDir, instructions: '' });
    const hasAnyContent = Boolean(
        slots.recent_turns || slots.memory_hits || slots.grep_hits || slots.task_snapshot,
    );
    if (!hasAnyContent) return { refreshed: false };

    const bootstrap = renderBootstrapPrompt(slots);
    const trace = `${BOOTSTRAP_TRACE_PREFIX}\n${bootstrap}`;

    const { db, insertMessageWithTrace, clearSessionBucket } = await import('./db.js');
    const { resolveSessionBucket } = await import('../agent/args.js');
    const {
        writeMainSessionRow,
        buildClearedSessionRow,
        setPendingBootstrapPromptStrict,
    } = await import('./main-session.js');

    const targetBucket = resolveSessionBucket(opts.toCli, opts.toModel);
    const clearedRow = buildClearedSessionRow();

    const tx = db.transaction(() => {
        insertMessageWithTrace.run(
            'assistant', COMPACT_MARKER_CONTENT,
            opts.toCli, opts.toModel, trace, null, opts.targetWorkDir,
        );
        setPendingBootstrapPromptStrict(bootstrap);
        writeMainSessionRow(clearedRow);
        if (targetBucket) clearSessionBucket.run(targetBucket);
    });
    tx();

    const { bumpSessionOwnershipGeneration } = await import('../agent/session-persistence.js');
    bumpSessionOwnershipGeneration();

    try {
        const { broadcast } = await import('./bus.js');
        broadcast('system_notice', {
            code: 'cli_switch_refresh',
            text: `CLI switched ${opts.fromCli} → ${opts.toCli} — session refreshed`,
        }, 'public');
    } catch (e) {
        console.warn('[jaw:cli-switch] notice broadcast failed:', (e as Error).message);
    }

    return { refreshed: true };
}

export async function autoCompactRefresh(opts: {
    workDir: string;
    instructions: string;
    cli: string;
    model: string;
}) {
    const slots = harvestBootstrapSlots({ workingDir: opts.workDir, instructions: opts.instructions });
    const bootstrap = renderBootstrapPrompt(slots);
    const trace = `${BOOTSTRAP_TRACE_PREFIX}\n${bootstrap}`;

    const { insertMessageWithTrace } = await import('./db.js');
    const { bumpSessionOwnershipGeneration } = await import('../agent/session-persistence.js');
    const { clearBossSessionOnly, setPendingBootstrapPrompt } = await import('./main-session.js');
    const { broadcast } = await import('./bus.js');

    insertMessageWithTrace.run('assistant', COMPACT_MARKER_CONTENT, opts.cli, opts.model, trace, null, opts.workDir);
    setPendingBootstrapPrompt(bootstrap);
    bumpSessionOwnershipGeneration();
    clearBossSessionOnly();

    broadcast('system_notice', { code: 'auto_compact_refresh', text: 'compact detected — session refreshed' }, 'public');
}

export function renderBootstrapPrompt(slots: BootstrapSlots): string {
    const sections: string[] = [];
    const push = (tag: string, body: string) => {
        const trimmed = (body || '').trim();
        if (!trimmed) return;
        sections.push(`<${tag}>\n${trimmed}\n</${tag}>`);
    };

    const header = [
        '# Compacted Session Handoff',
        '',
        'The conversation history has been summarized to free up context. You are continuing the task from a previous session. Treat the sections below as the authoritative state. Do not repeat completed work. If critical context is missing, ask one clarifying question before acting.',
    ].join('\n');

    push('overall_goal', slots.goal);
    push('recent_actions', slots.recent_turns);
    push('key_knowledge', slots.memory_hits);
    push('artifact_trail', slots.grep_hits);
    push('current_state', slots.task_snapshot);

    const footer = [
        '## Continuation Instructions',
        'Resume from the plan in <current_state>. Do not repeat work already listed under <recent_actions>.',
        '',
        'The sections above are a starting snapshot built at compact time. The live memory index has more than was harvested. Before answering:',
        '- Run `cli-jaw memory search "<keywords>"` for any term in <overall_goal> or the user\'s next message.',
        '- Use `cli-jaw memory read <path>` to expand any line referenced in <key_knowledge> or <current_state>.',
        '- If saving a durable fact, use `cli-jaw memory save <file> <content>` with an explicit destination such as `structured/episodes/live/YYYY-MM-DD.md`.',
        '- If a referenced file in <artifact_trail> is relevant, open it directly with the file-read tool — do not rely on the snippet alone.',
    ].join('\n');

    let out = [header, '', sections.join('\n\n'), '', footer, ''].join('\n');
    if (out.length > BOOTSTRAP_BUDGET.total_max) {
        const shrunk = { ...slots };
        const lines = shrunk.recent_turns.split('\n');
        while (out.length > BOOTSTRAP_BUDGET.total_max && lines.length > 1) {
            lines.shift();
            shrunk.recent_turns = lines.join('\n');
            out = renderBootstrapPrompt(shrunk);
            if (lines.length <= 1) break;
        }
    }
    return out;
}
