import { listTabs, getPageByTargetId } from '../connection.js';

// Parity catalog 102 (tab-inspect). Strict-TS port of agbrowse web-ai/tab-inspect.mjs.
// Enumerate ALL ChatGPT tabs → running/completed/detached/stalled, with stall re-probe
// via fingerprint and orphan-harvest. cli-jaw tab-recovery handles a single known session
// only. Adapted from raw chrome-remote-interface to cli-jaw's Playwright connection layer
// (listTabs / getPageByTargetId). classifyTabState + buildTabSummary are pure/testable.

export type TabState = 'running' | 'completed' | 'detached' | 'stalled';

export interface TabSummary {
    targetId: string;
    title: string;
    url: string;
    vendor: string;
    modelLabel: string | null;
    stopExists: boolean;
    sendExists: boolean;
    promptReady: boolean;
    authenticated: boolean;
    assistantCount: number;
    lastAssistantText: string | null;
    lastAssistantSnippet: string | null;
    conversationId: string | null;
    fingerprint: string | null;
    state: TabState;
}

/** Tab metadata carried alongside inspection (title/url may be absent). */
export interface TabMeta {
    title?: string | undefined;
    url?: string | undefined;
}

export interface InspectionData {
    stopExists?: boolean;
    sendExists?: boolean;
    promptReady?: boolean;
    authenticated?: boolean;
    assistantCount?: number;
    lastAssistantText?: string | null;
    lastAssistantSnippet?: string | null;
    modelLabel?: string | null;
    conversationId?: string | null;
    fingerprint?: string | null;
}

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

export const INSPECT_EXPRESSION = `(() => {
    const stopBtn = document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label*="Stop"]');
    const sendBtn = document.querySelector('[data-testid="send-button"], button[aria-label="Send prompt"]');
    const composer = document.querySelector('#prompt-textarea, [contenteditable="true"]');
    const authEl = document.querySelector('[data-testid="profile-button"], img[alt="User"]');
    const assistants = document.querySelectorAll('[data-message-author-role="assistant"]');
    const lastAssistant = assistants[assistants.length - 1];
    const lastText = lastAssistant?.innerText?.trim() || null;
    const modelEl = document.querySelector('[data-testid="model-switcher"] span, button[aria-haspopup="menu"] > div > span');
    const convMatch = window.location.pathname.match(/\\/c\\/([a-f0-9-]+)/);
    return JSON.stringify({
        stopExists: !!stopBtn,
        sendExists: !!sendBtn,
        promptReady: !!(sendBtn || (composer && !stopBtn)),
        authenticated: !!authEl,
        assistantCount: assistants.length,
        lastAssistantText: lastText,
        lastAssistantSnippet: lastText ? lastText.slice(0, 200) : null,
        modelLabel: modelEl?.textContent?.trim() || null,
        conversationId: convMatch ? convMatch[1] : null,
        fingerprint: lastText ? String(assistants.length) + ':' + String(lastText.length) : null,
    });
})()`;

/** Classify tab state from inspection data (pure). */
export function classifyTabState(summary: {
    authenticated: boolean;
    stopExists: boolean;
    sendExists: boolean;
    promptReady: boolean;
    assistantCount: number;
}): TabState {
    if (!summary.authenticated) return 'detached';
    if (summary.stopExists) return 'running';
    if (summary.sendExists || summary.promptReady || summary.assistantCount > 0) return 'completed';
    return 'detached';
}

/** Build a normalized TabSummary from raw inspection data (pure). */
export function buildTabSummary(
    targetId: string,
    data: InspectionData,
    meta: TabMeta = {},
): TabSummary {
    const normalized = {
        authenticated: !!data.authenticated,
        stopExists: !!data.stopExists,
        sendExists: !!data.sendExists,
        promptReady: !!data.promptReady,
        assistantCount: data.assistantCount || 0,
    };
    return {
        targetId,
        title: meta.title || '',
        url: meta.url || '',
        vendor: 'chatgpt',
        modelLabel: data.modelLabel || null,
        stopExists: normalized.stopExists,
        sendExists: normalized.sendExists,
        promptReady: normalized.promptReady,
        authenticated: normalized.authenticated,
        assistantCount: normalized.assistantCount,
        lastAssistantText: data.lastAssistantText || null,
        lastAssistantSnippet: data.lastAssistantSnippet || null,
        conversationId: data.conversationId || null,
        fingerprint: data.fingerprint || null,
        state: classifyTabState(normalized),
    };
}

function isChatgptUrl(url: string): boolean {
    try {
        return CHATGPT_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
}

/** Inspect a single ChatGPT tab via Playwright (CDP-backed). */
export async function inspectTab(
    port: number,
    targetId: string,
    meta: TabMeta = {},
): Promise<TabSummary> {
    const page = await getPageByTargetId(port, targetId);
    if (!page) {
        return buildTabSummary(targetId, { authenticated: false }, meta);
    }
    const raw = (await page.evaluate(INSPECT_EXPRESSION).catch(() => null)) as string | InspectionData | null;
    let data: InspectionData = {};
    if (typeof raw === 'string') {
        try { data = JSON.parse(raw) as InspectionData; } catch { data = {}; }
    } else if (raw && typeof raw === 'object') {
        data = raw;
    }
    return buildTabSummary(targetId, data, meta);
}

/** Harvest assistant markdown from a ChatGPT tab, re-probing a running tab for a stall. */
export async function harvestTab(
    port: number,
    targetId: string,
    { stallWindowMs, title, url }: { stallWindowMs?: number } & TabMeta = {},
): Promise<TabSummary & { lastAssistantMarkdown?: string }> {
    let summary = await inspectTab(port, targetId, { title, url });

    if (summary.state === 'running' && stallWindowMs && stallWindowMs > 0) {
        await new Promise((r) => setTimeout(r, stallWindowMs));
        const after = await inspectTab(port, targetId, { title, url });
        if (after.fingerprint === summary.fingerprint) {
            summary = { ...after, state: 'stalled' };
        } else {
            summary = after;
        }
    }

    const result: TabSummary & { lastAssistantMarkdown?: string } = { ...summary };
    if (summary.lastAssistantText) result.lastAssistantMarkdown = summary.lastAssistantText;
    return result;
}

/** Collect and inspect all ChatGPT tabs (running tabs sorted first). */
export async function collectTabs(
    port: number,
    { activeTargetIds = new Set<string>(), stallWindowMs = 0 }: { activeTargetIds?: Set<string>; stallWindowMs?: number } = {},
): Promise<(TabSummary & { inUse: boolean })[]> {
    const tabs = await listTabs(port);
    const chatgptTabs = tabs.filter((t) => t.type === 'page' && isChatgptUrl(t.url));

    const results: (TabSummary & { inUse: boolean })[] = [];
    for (const target of chatgptTabs) {
        const inUse = activeTargetIds.has(target.targetId);
        if (inUse) {
            results.push({
                ...buildTabSummary(target.targetId, { authenticated: false }, { title: target.title, url: target.url }),
                state: 'completed',
                inUse: true,
            });
            continue;
        }
        try {
            const summary = stallWindowMs > 0
                ? await harvestTab(port, target.targetId, { stallWindowMs, title: target.title, url: target.url })
                : await inspectTab(port, target.targetId, { title: target.title, url: target.url });
            results.push({ ...summary, inUse: false });
        } catch {
            continue;
        }
    }

    return results.sort((a, b) => {
        if (a.state === 'running' && b.state !== 'running') return -1;
        if (b.state === 'running' && a.state !== 'running') return 1;
        return 0;
    });
}
