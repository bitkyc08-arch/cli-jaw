import { escapeHtml } from '../render.js';
import { providerLabel } from '../provider-icons.js';
import { t } from './i18n.js';
import type { QuotaEntry } from './settings-types.js';

type QuotaSetupHint = {
    title: string;
    description?: string;
    commands: string[];
    note?: string;
};

export const QUOTA_HIDDEN_CLIS = new Set(['ai-e', 'codex-app']);
export const SIDEBAR_HIDDEN_CLIS = new Set(['claude-e', 'jwc']);
export const QUOTA_CUSTOM_MSG: Record<string, string> = {
    claude: 'Currently subscribed, by June with credit',
};

export const QUOTA_SETUP_HINTS: Record<string, QuotaSetupHint> = {
    cursor: {
        title: 'Enable quota bars (dashboard session)',
        commands: [
            'cursor-agent login',
            'export CURSOR_SESSION_TOKEN="<WorkosCursorSessionToken from cursor.com DevTools>"',
            'echo "$CURSOR_SESSION_TOKEN" > ~/.cli-jaw/quota/cursor-session-token && chmod 600 ~/.cli-jaw/quota/cursor-session-token',
        ],
    },
    agy: {
        title: 'Enable Gem / Cla quota bars',
        commands: [
            'npx antigravity-usage login',
            'npx antigravity-usage --json',
        ],
    },
    grok: {
        title: 'Grok login',
        commands: [
            'progrok login',
        ],
    },
    opencode: {
        title: 'OpenCode auth + optional plan quota plugin',
        commands: [
            'opencode auth login',
            'opencode plugin add @slkiser/opencode-quota',
            'npx @slkiser/opencode-quota show',
        ],
        note: 'Built-in opencode stats shows session tokens/cost, not subscription limits. opencode-go/* models use the same CLI.',
    },
};

export function normalizeQuotaWindowLabel(cliName: string, label: string): string {
    if (cliName === 'gemini') {
        if (label === 'Pro' || label === 'P') return 'P';
        if (label === 'Flash' || label === 'F') return 'F';
        return label;
    }

    if (cliName === 'copilot') {
        if (label === 'Premium' || label === 'Prem') return '30d';
        if (label.includes('plus monthly subscriber quota')) return '30d';
    }

    return label
        .replace('-hour', 'h')
        .replace('-day', 'd')
        .replace(' Sonnet', '')
        .replace(' Opus', '');
}

export function describeStatusOnlyQuota(cliName: string, q: QuotaEntry): string {
    if (q.delegatedProvider) return `Delegates quota/status to ${q.delegatedProvider}`;
    const match = q.quotaSource?.match(/^not-exposed-by-(.*?)-cli$/);
    if (match) return `Quota not exposed by ${match[1].toUpperCase()} CLI`;
    if (q.quotaSource) return q.quotaSource;
    return cliName === 'opencode' ? 'Auth/status only' : 'Usage data not exposed by this CLI';
}

function normalizeAccountToken(value: string): string {
    return value.toLowerCase().replace(/^cursor\s+/i, '').trim();
}

export const ACCOUNT_LABEL_SKIP = new Set([
    'auth/status only',
    'google cloud code',
    'runtime-checked',
]);

export const PROVIDER_ACCOUNT_TYPES = new Set([
    'cursor',
    'antigravity.google',
    'antigravity',
    'max',
    'copilot',
    'gemini',
]);

export function buildAccountParts(_cliName: string, q: QuotaEntry): string[] {
    const account = q.account;
    if (!account) return [];

    const parts: string[] = [];
    if (account.email) parts.push(account.email);

    const seen = new Set(parts.map(normalizeAccountToken));
    for (const value of [account.plan, account.tier]) {
        if (!value) continue;
        const norm = normalizeAccountToken(value);
        if (!norm || ACCOUNT_LABEL_SKIP.has(norm)) continue;
        if (PROVIDER_ACCOUNT_TYPES.has(norm)) continue;
        if (seen.has(norm)) continue;
        seen.add(norm);
        parts.push(value);
        break;
    }

    return parts;
}

export function renderSetupHelpMark(cliName: string, q: QuotaEntry, extraTooltip: string[] = []): string {
    const hint = QUOTA_SETUP_HINTS[cliName];
    const tooltipParts = [
        ...extraTooltip,
        ...(hint ? hint.commands : []),
        ...(hint?.note ? [hint.note] : []),
    ].filter(Boolean);
    if (!tooltipParts.length) return '';
    const tooltip = escapeHtml(tooltipParts.join('\n'));
    const descAttr = hint?.description ? ` data-cli-help-desc="${escapeHtml(hint.description)}"` : '';
    return `<button type="button" class="help-trigger" style="margin-left:4px" data-cli-help="${tooltip}"${descAttr} aria-label="Setup help">?</button>`;
}

export function renderQuotaSetupBox(cliName: string, q: QuotaEntry): string {
    const hint = QUOTA_SETUP_HINTS[cliName];
    const usage = q.sessionUsage;
    const extraTooltip: string[] = [];
    if (usage?.primaryModelId) extraTooltip.push(`Model: ${usage.primaryModelId}`);
    if (usage?.contextTokensUsed && usage?.contextWindowTokens) {
        extraTooltip.push(`Session context: ${Math.round(usage.contextTokensUsed).toLocaleString()} / ${Math.round(usage.contextWindowTokens).toLocaleString()} tokens`);
    } else if (usage?.turnCount) {
        extraTooltip.push(`Session turns: ${Math.round(usage.turnCount).toLocaleString()}`);
    }
    const helpMark = renderSetupHelpMark(cliName, q, extraTooltip);

    if (hint) {
        const commandLines = hint.commands.map(cmd => `
            <div style="margin-top:3px"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px;word-break:break-all">${escapeHtml(cmd)}</code></div>
        `).join('');
        const descriptionHtml = hint.description
            ? `<div style="margin-top:3px;color:var(--text-dim);font-size:10px">${escapeHtml(hint.description)}</div>`
            : '';
        return `
            <details class="cli-setup-details" style="font-size:10px;color:var(--text-dim);margin:4px 0 0 16px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px">
                <summary style="color:var(--text);font-weight:600;cursor:pointer;list-style:none">${escapeHtml(hint.title)}${helpMark}</summary>
                ${descriptionHtml}
                ${commandLines}
                ${hint.note ? `<div style="margin-top:4px;opacity:0.75">${escapeHtml(hint.note)}</div>` : ''}
            </details>
        `;
    }

    return `
        <div style="font-size:10px;color:var(--text-dim);margin:4px 0 0 16px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px">
            <div style="color:var(--text);font-weight:600">${escapeHtml(q.displayTier || providerLabel(cliName))}${helpMark}</div>
            <div style="margin-top:2px">${escapeHtml(describeStatusOnlyQuota(cliName, q))}</div>
        </div>
    `;
}
