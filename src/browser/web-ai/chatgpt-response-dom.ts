import type { Page } from 'playwright-core';

/**
 * ChatGPT assistant-turn DOM readers. Full strict-TS port of agbrowse
 * web-ai/chatgpt-response-dom.mjs (parity2 040 slice 4.1, catalog C-09):
 * composer-scoped tri-state stop probe, main-region scoping, role-verified
 * top-level turn resolution, completed-reasoning grammar with activity
 * strata, wrapped/wrapperless correlated snapshots in one DOM-order pass,
 * and unread-vs-empty locator fallback.
 */

export const CHATGPT_ASSISTANT_SELECTORS: string[] = [
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
    'article[data-testid^="conversation-turn"]',
];

// parity2 040 (C-09/G1b): form-scoped stop selector — page-wide "any
// Stop-labelled button" matched dictation/voice/read-aloud/sidebar controls.
export const CHATGPT_STOP_SELECTORS: string[] = [
    'button[data-testid="stop-button"]',
    'form button[aria-label*="Stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])',
];

export const CHATGPT_TURN_SELECTORS: string[] = [
    'article[data-testid^="conversation-turn"]',
    'div[data-testid^="conversation-turn"]',
    'section[data-testid^="conversation-turn"]',
];

export type ChatGptTurnOrderingInPage = 'ordered' | 'stale' | 'unverifiable';
export type ChatGptStopVerdict = 'visible' | 'absent' | 'unknown';
export type ChatGptActivityStrength = 'strong' | 'weak' | 'none' | 'unknown';
export interface ChatGptActivityState { strength: ChatGptActivityStrength; evidence: string }
export interface ChatGptAssistantSnapshot {
    text: string;
    messageId: string | null;
    turnId: string | null;
    turnIndex: number;
}
export type ChatGptCorrelatedSnapshot = ChatGptAssistantSnapshot & { source: 'wrapped' | 'wrapperless'; domOrder: number };

type AnyNode = any;
declare const document: any;
declare const window: any;
declare const Node: any;
declare const HTMLElement: any;
declare const HTMLProgressElement: any;

/**
 * Browser-context helper. Reports whether the latest assistant turn follows the
 * latest user turn. Returns a VERDICT, not a boolean — "cannot verify" and
 * "verified ordered" are different facts. Never reports 'unknown' itself; only
 * the Node-side wrapper's catch produces that value.
 */
export function readAssistantTurnOrderingInPage(selectors: string[]): ChatGptTurnOrderingInPage {
    const turns: AnyNode[] = Array.from(document.querySelectorAll(selectors.join(', ')));
    const roleOf = (turn: AnyNode) => turn.getAttribute('data-message-author-role')
        || turn.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
    const lastAssistantTurn = turns.filter((turn) => roleOf(turn) === 'assistant').at(-1);
    const lastUserTurn = turns.filter((turn) => roleOf(turn) === 'user').at(-1);
    if (!lastUserTurn) return 'unverifiable';
    if (!lastAssistantTurn) return 'stale';
    return lastUserTurn.compareDocumentPosition(lastAssistantTurn) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'ordered'
        : 'stale';
}

/**
 * Node-side probe: is a composer-scoped stop button visible within scope?
 * Reports a VERDICT: 'unknown' whenever the selectors and nodes could not be
 * fully enumerated; a visible node short-circuits to 'visible'. EVERY match is
 * inspected, not just the first — ChatGPT can render a hidden stop node ahead
 * of the live one.
 */
export async function probeStopButton(scope: AnyNode): Promise<ChatGptStopVerdict> {
    if (!scope || typeof scope.locator !== 'function') return 'unknown';
    let anySelectorUninspected = false;
    for (const selector of CHATGPT_STOP_SELECTORS) {
        let locator: AnyNode;
        try { locator = scope.locator(selector); } catch { anySelectorUninspected = true; continue; }
        if (!locator || typeof locator.all !== 'function') { anySelectorUninspected = true; continue; }
        let nodes: AnyNode[];
        try { nodes = await locator.all(); } catch { anySelectorUninspected = true; continue; }
        if (!Array.isArray(nodes)) { anySelectorUninspected = true; continue; }
        let anyNodeUninspected = false;
        for (const node of nodes) {
            if (typeof node?.isVisible !== 'function') { anyNodeUninspected = true; continue; }
            try {
                if (await node.isVisible()) return 'visible';
            } catch { anyNodeUninspected = true; }
        }
        if (anyNodeUninspected) anySelectorUninspected = true;
    }
    return anySelectorUninspected ? 'unknown' : 'absent';
}

/** Back-compatible boolean view of the stop probe. */
export async function anyStopButtonVisible(scope: AnyNode): Promise<boolean> {
    return (await probeStopButton(scope)) === 'visible';
}

/**
 * Narrow a page to its main conversation region when it exposes one — sidebar
 * history titles poison page-wide text matching. Returns null only on a FAILED
 * lookup ("no usable scope"), which probeStopButton reports as 'unknown'.
 */
export function scopeToMainRegion(page: AnyNode): AnyNode {
    let main: AnyNode;
    try { main = page?.locator?.('main'); } catch { return null; }
    if (main && typeof main.locator === 'function') return main;
    return page;
}

/**
 * Browser-context: resolve role-verified, top-level assistant turns in document
 * order. Wrapper-collapsed and descendant-de-duplicated.
 */
export function resolveTopLevelAssistantTurns(selectors: string[]): AnyNode[] {
    const activeSelectors = Array.isArray(selectors) && selectors.length
        ? selectors
        : [
            '[data-message-author-role="assistant"]',
            '[data-turn="assistant"]',
            'article[data-testid^="conversation-turn"]',
        ];
    const roleSelectors = [
        '[data-message-author-role="assistant"]',
        '[data-turn="assistant"]',
    ];
    const roleNodes: AnyNode[] = [];
    for (const selector of roleSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
            if (!roleNodes.includes(node)) roleNodes.push(node);
        }
    }
    const turns: AnyNode[] = [];
    for (const roleNode of roleNodes) {
        const wrapperSelectors = activeSelectors.filter(selector => !roleSelectors.includes(selector));
        const candidate = wrapperSelectors.length && typeof roleNode.closest === 'function'
            ? roleNode.closest(wrapperSelectors.join(', ')) || roleNode
            : roleNode;
        if (turns.some(turn => turn === candidate || turn.contains(candidate))) continue;
        for (let i = turns.length - 1; i >= 0; i--) {
            if (candidate.contains(turns[i])) turns.splice(i, 1);
        }
        turns.push(candidate);
    }
    return turns;
}

/**
 * Browser-context: live-generation evidence with STRENGTH strata. A visible
 * stop button or live progress is strong; a mounted sidecar still reading
 * "Thinking" is weak; a completed-reasoning summary ("Thought for 12s") is
 * neither. Anchored grammar keeps a growing trace from reading as completion.
 */
export function readChatGptStreamingState({ assistantSelectors, stopSelectors, resolverSource }: { assistantSelectors: string[]; stopSelectors: string[]; resolverSource?: string }): ChatGptActivityState {
    const UNIT = '(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)';
    const NUMERIC = `\\d+(?:\\.\\d+)?\\s*${UNIT}`;
    const COMPLETED_SUMMARY = new RegExp(
        '^(?:(?:reasoning|pro thinking)\\s*)?thought for '
        + `(?:${NUMERIC}(?:\\s+${NUMERIC})*|(?:a|an) [a-z]+(?: [a-z]+){0,2})`
        + '(?: edit)?$',
    );
    const isVisible = (node: AnyNode): boolean => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    const norm = (value: unknown): string => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const hasLiveProgress = (scope: AnyNode): boolean => {
        let nodes: AnyNode;
        try { nodes = scope.querySelectorAll('progress, [role="progressbar"]'); } catch { return false; }
        return Array.from(nodes).some((node: AnyNode) => {
            if (!isVisible(node)) return false;
            if (node instanceof HTMLProgressElement) {
                if (!node.hasAttribute('value')) return true;
                return Number.isFinite(node.value) && Number.isFinite(node.max) ? node.value < node.max : true;
            }
            const rawNow = node.getAttribute('aria-valuenow');
            if (rawNow == null) return true;
            const now = Number(rawNow);
            const rawMax = node.getAttribute('aria-valuemax');
            const max = rawMax != null && Number.isFinite(Number(rawMax)) ? Number(rawMax) : 100;
            return Number.isFinite(now) ? now < max : true;
        });
    };

    for (const selector of stopSelectors) {
        let nodes: AnyNode;
        try { nodes = document.querySelectorAll(selector); } catch { continue; }
        if (Array.from(nodes).some(isVisible)) return { strength: 'strong', evidence: 'stop-button' };
    }

    let assistantNodes: AnyNode[] = [];
    try {
        const resolver = resolverSource
            ? (0, eval)(`(${resolverSource})`)
            : resolveTopLevelAssistantTurns;
        assistantNodes = resolver(assistantSelectors);
    } catch { /* selector drift fails closed */ }
    const latestAssistant = assistantNodes.at(-1);
    if (latestAssistant) {
        if (hasLiveProgress(latestAssistant)) return { strength: 'strong', evidence: 'turn-progress' };
    }

    let panels: AnyNode;
    try {
        panels = document.querySelectorAll(
            'aside, [role="complementary"], [role="dialog"], [data-testid*="thinking" i], [data-testid*="reasoning" i], [class*="sidecar" i]',
        );
    } catch {
        return { strength: 'none', evidence: '' };
    }
    let weakVerdict: ChatGptActivityState | null = null;
    for (const panel of Array.from(panels) as AnyNode[]) {
        if (!isVisible(panel)) continue;
        const metadata = norm([
            panel.getAttribute('aria-label'),
            panel.getAttribute('data-testid'),
            panel.getAttribute('class'),
        ].filter(Boolean).join(' '));
        const verifiedThinkingPanel = metadata.includes('thinking')
            || metadata.includes('reasoning')
            || metadata.includes('sidecar');
        if (!verifiedThinkingPanel) continue;
        const rect = panel.getBoundingClientRect();
        const rightSide = rect.left >= window.innerWidth * 0.35
            && rect.width >= 180
            && rect.height >= 120;
        if (!rightSide) continue;
        if (hasLiveProgress(panel)) return { strength: 'strong', evidence: 'panel-progress' };
        const visibleText = norm(panel.textContent);
        if (COMPLETED_SUMMARY.test(visibleText)) continue;
        if (visibleText.includes('thought for ')) {
            weakVerdict = weakVerdict || { strength: 'weak', evidence: 'panel-trace' };
            continue;
        }
        if (visibleText.includes('thinking')
            || visibleText.includes('reasoning')
            || visibleText.includes('pro thinking')) {
            weakVerdict = weakVerdict || { strength: 'weak', evidence: 'panel-text' };
        }
    }
    return weakVerdict || { strength: 'none', evidence: '' };
}

/**
 * Back-compatible boolean view of an activity verdict. 'unknown' reads as
 * INACTIVE here — safe only for consumers gating success on independent
 * terminal evidence.
 */
export function isActiveState(state: ChatGptActivityState | boolean | null | undefined): boolean {
    if (typeof state === 'boolean') return state;
    return Boolean(state && state.strength !== 'none' && state.strength !== 'unknown');
}

/**
 * Browser-context: single acquisition for both snapshot sources sharing one
 * document-order coordinate space. Wrapperless markdown only qualifies when it
 * DOM-FOLLOWS the latest user node. `ok` distinguishes a successful empty
 * acquisition from a failure.
 */
export function readAssistantSnapshotSources({ assistantSelectors, resolverSource, userSelectors, markdownSelectors }: { assistantSelectors: string[]; resolverSource?: string; userSelectors?: string[]; markdownSelectors?: string[] }): { ok: true; wrapped: ChatGptCorrelatedSnapshot[]; wrapperless: ChatGptCorrelatedSnapshot[] } {
    const USER_SELECTORS = (userSelectors && userSelectors.length) ? userSelectors : [
        '[data-message-author-role="user"]',
        '[data-turn="user"]',
    ];
    const MARKDOWN_SELECTORS = (markdownSelectors && markdownSelectors.length) ? markdownSelectors : [
        '.markdown',
        '[data-message-content]',
    ];
    const WRAPPER_SELECTORS = [
        '[data-message-author-role]',
        '[data-turn]',
        'article[data-testid^="conversation-turn"]',
    ];

    const FOLLOWING = document?.defaultView?.Node?.DOCUMENT_POSITION_FOLLOWING ?? 4;
    const isVisible = (node: AnyNode): boolean => {
        const rect = node.getBoundingClientRect?.();
        return Boolean(rect) && rect.width > 0 && rect.height > 0;
    };
    const orderNodes = (nodes: AnyNode[]): AnyNode[] => {
        const unique = Array.from(new Set(nodes));
        unique.sort((a, b) => (a.compareDocumentPosition(b) & FOLLOWING) ? -1 : 1);
        return unique;
    };
    const textOf = (node: AnyNode): string => String(node.innerText || node.textContent || '').trim();
    const describe = (node: AnyNode) => {
        const messageNode = node.matches?.('[data-message-id]') ? node : node.querySelector?.('[data-message-id]');
        const turnNode = node.matches?.('[data-testid^="conversation-turn"]')
            ? node
            : node.querySelector?.('[data-testid^="conversation-turn"]');
        return {
            text: textOf(node),
            messageId: messageNode?.getAttribute?.('data-message-id') || null,
            turnId: turnNode?.getAttribute?.('data-testid') || null,
        };
    };

    let wrappedNodes: AnyNode[] = [];
    try {
        const resolver = resolverSource ? (0, eval)(`(${resolverSource})`) : null;
        wrappedNodes = resolver ? (resolver(assistantSelectors) || []) : [];
    } catch { wrappedNodes = []; }

    const userNodes = orderNodes(USER_SELECTORS.flatMap(
        (selector: string) => Array.from(document.querySelectorAll(selector))));
    const latestUser = userNodes[userNodes.length - 1] || null;

    const wrapperlessNodes = orderNodes(MARKDOWN_SELECTORS.flatMap(
        (selector: string) => Array.from(document.querySelectorAll(selector))))
        .filter((node: AnyNode) => isVisible(node))
        .filter((node: AnyNode) => !node.closest?.(WRAPPER_SELECTORS.join(', ')))
        .filter((node: AnyNode) => Boolean(latestUser)
            && (latestUser.compareDocumentPosition(node) & FOLLOWING) !== 0)
        .filter((node: AnyNode) => textOf(node));

    const order = new Map(orderNodes([...wrappedNodes, ...wrapperlessNodes])
        .map((node, index) => [node, index]));

    return {
        ok: true,
        wrapped: wrappedNodes.map((node: AnyNode, turnIndex: number) => ({
            ...describe(node), turnIndex, source: 'wrapped' as const, domOrder: order.get(node) ?? turnIndex,
        })),
        wrapperless: wrapperlessNodes.map((node: AnyNode) => ({
            ...describe(node), turnIndex: -1, source: 'wrapperless' as const, domOrder: order.get(node) ?? 0,
        })),
    };
}

/** Browser-context: snapshots (text + provenance) of top-level assistant turns. */
export function readTopLevelAssistantSnapshots(input: string[] | { selectors: string[]; resolverSource?: string }): ChatGptAssistantSnapshot[] {
    const selectors = Array.isArray(input) ? input : input?.selectors;
    const resolverSource = Array.isArray(input) ? '' : input?.resolverSource;
    const resolver = resolverSource
        ? (0, eval)(`(${resolverSource})`)
        : resolveTopLevelAssistantTurns;
    return resolver(selectors as string[]).map((node: AnyNode, turnIndex: number) => {
        const messageNode = node.matches?.('[data-message-id]')
            ? node
            : node.querySelector?.('[data-message-id]');
        const turnNode = node.matches?.('[data-testid^="conversation-turn"]')
            ? node
            : node.querySelector?.('[data-testid^="conversation-turn"]');
        return {
            text: String(node.innerText || node.textContent || '').trim(),
            messageId: messageNode?.getAttribute?.('data-message-id') || null,
            turnId: turnNode?.getAttribute?.('data-testid') || null,
            turnIndex,
        };
    }).filter((snapshot: ChatGptAssistantSnapshot) => Boolean(snapshot.text));
}

/** Browser-context helper: texts of top-level assistant turns. */
export function readTopLevelAssistantTexts(selectors: string[]): string[] {
    return readTopLevelAssistantSnapshots(selectors).map(snapshot => snapshot.text);
}

/**
 * Locator-based fallback. Reports whether the read HAPPENED, not just what it
 * found: a PARTIAL read is not a smaller success — it corrupts positional
 * baselines. `ok: true` with an empty list means every path was examined.
 */
export async function readTopLevelAssistantTextsFromLocators(
    page: Page,
    selectors: string[] = CHATGPT_ASSISTANT_SELECTORS,
): Promise<{ ok: boolean; texts: string[] }> {
    let anySelectorFailed = false;
    for (const selector of selectors) {
        let locators: AnyNode[];
        try {
            locators = await (page as AnyNode).locator(selector).all();
            if (!Array.isArray(locators)) throw new Error('locator.all() did not return a list');
        } catch {
            anySelectorFailed = true;
            continue;
        }
        const texts: string[] = [];
        let anyNodeUnread = false;
        for (const locator of locators) {
            let text = '';
            let read = true;
            if (typeof locator.evaluate === 'function') {
                text = await locator.evaluate((node: AnyNode, activeSelector: string) => {
                    const matched = Array.from(document.querySelectorAll(activeSelector));
                    const nested = matched.some((other: AnyNode) =>
                        other !== node && typeof other.contains === 'function' && other.contains(node));
                    if (nested) return '';
                    return String(node.innerText || node.textContent || '').trim();
                }, selector).catch(() => { read = false; return ''; });
            } else {
                text = await locator.innerText().catch(() => { read = false; return ''; });
            }
            if (!read) anyNodeUnread = true;
            text = String(text || '').trim();
            if (text) texts.push(text);
        }
        if (anyNodeUnread) {
            anySelectorFailed = true;
            continue;
        }
        if (texts.length) return { ok: true, texts };
    }
    return { ok: !anySelectorFailed, texts: [] };
}

