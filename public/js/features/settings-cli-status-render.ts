import { escapeHtml } from '../render.js';
import { providerLabel } from '../provider-icons.js';
import { t } from './i18n.js';
import type { QuotaEntry } from './settings-types.js';

type QuotaSetupHint = {
    title: string;
    description?: string;
    commands: string[];
    note?: string;
    links?: { label: string; url: string }[];
};

export const QUOTA_HIDDEN_CLIS = new Set(['ai-e', 'codex-app']);
export const SIDEBAR_HIDDEN_CLIS = new Set(['ai-e', 'claude-e', 'jwc', 'pi', 'codex-app', 'gemini']);
export const QUOTA_CUSTOM_MSG: Record<string, string> = {};

export const QUOTA_SETUP_HINTS: Record<string, QuotaSetupHint> = {
    cursor: {
        title: 'Enable quota bars (dashboard session)',
        description: 'Cursor does not expose quota via its CLI. To display usage bars, log in with cursor-agent or manually export your session token from cursor.com DevTools (Application → Cookies → WorkosCursorSessionToken).',
        commands: [
            'cursor-agent login',
            'export CURSOR_SESSION_TOKEN="<WorkosCursorSessionToken from cursor.com DevTools>"',
            'echo "$CURSOR_SESSION_TOKEN" > ~/.cli-jaw/quota/cursor-session-token && chmod 600 ~/.cli-jaw/quota/cursor-session-token',
        ],
    },
    agy: {
        title: 'Enable Gem / Cla quota bars',
        description: 'Antigravity wraps Google Gemini and Claude models. Log in with antigravity-usage to fetch your remaining Gem/Cla tier quotas.',
        commands: [
            'npx antigravity-usage login',
            'npx antigravity-usage --json',
        ],
    },
    grok: {
        title: 'Grok login',
        description: 'Authenticate with Grok (X/Twitter AI) to enable quota tracking and model access through the progrok proxy.',
        commands: [
            'progrok login',
        ],
    },
    opencode: {
        title: 'OpenCode Go quota (API key)',
        description: 'cli-jaw reads your sk- API key from ~/.local/share/opencode/auth.json (opencode-go) or OPENCODE_GO_API_KEY, then calls GET /zen/go/v1/usage. The usage endpoint is not deployed yet — quota bars appear when upstream ships it. Your key still works for models/chat.',
        commands: [
            'opencode providers login',
            'export OPENCODE_GO_API_KEY=sk-...',
            'curl -s -H "Authorization: Bearer $OPENCODE_GO_API_KEY" https://opencode.ai/zen/go/v1/usage',
        ],
        note: 'Not the opencode-quota plugin (cookie scrape). Built-in opencode stats = session tokens only.',
        links: [
            { label: 'OpenCode Go docs', url: 'https://opencode.ai/docs/go/' },
            { label: 'Upstream usage API issue #16017', url: 'https://github.com/anomalyco/opencode/issues/16017' },
            { label: 'Upstream usage API PR #16513', url: 'https://github.com/anomalyco/opencode/pull/16513' },
            { label: 'slkiser/opencode-quota (cookie workaround)', url: 'https://github.com/slkiser/opencode-quota' },
            { label: 'robinebers/openusage (local cost estimate)', url: 'https://github.com/robinebers/openusage' },
            { label: 'Rodowen/oc-go-monitor (cookie + /usage)', url: 'https://github.com/Rodowen/oc-go-monitor' },
        ],
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
    const linksAttr = hint?.links?.length
        ? ` data-cli-help-links="${escapeHtml(JSON.stringify(hint.links))}"`
        : '';
    return `<button type="button" class="help-trigger" style="margin-left:4px" data-cli-help="${tooltip}"${descAttr}${linksAttr} aria-label="Setup help">?</button>`;
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
        const linksHtml = hint.links?.length
            ? `<ul style="margin:6px 0 0;padding-left:16px;font-size:10px">${hint.links.map(link =>
                `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a></li>`
            ).join('')}</ul>`
            : '';
        return `
            <details class="cli-setup-details" style="font-size:10px;color:var(--text-dim);margin:4px 0 0 16px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px">
                <summary style="color:var(--text);font-weight:600;cursor:pointer;list-style:none">${escapeHtml(hint.title)}${helpMark}</summary>
                ${descriptionHtml}
                ${linksHtml}
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
