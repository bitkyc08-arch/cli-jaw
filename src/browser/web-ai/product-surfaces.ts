/**
 * PRD32.9 — read-only product surface index.
 *
 * These detectors intentionally do not mutate browser state. Deep Research,
 * Projects, Library, Apps, and Canvas are separate product flows, not normal
 * chat send/poll variants.
 */

export type ProductSurfaceId =
    | 'chatgpt-projects'
    | 'chatgpt-library'
    | 'chatgpt-apps'
    | 'chatgpt-deep-research'
    | 'gemini-deep-research'
    | 'canvas';

export interface ProductSurfaceStatus {
    id: ProductSurfaceId;
    available: boolean;
    evidence: string[];
    mutationAllowed: false;
}

interface SurfaceLocatorLike {
    first(): {
        isVisible(): Promise<boolean>;
    };
}

interface ProductSurfacePageLike {
    getByText?: (text: string, options: { exact: boolean }) => SurfaceLocatorLike;
    locator(selector: string): SurfaceLocatorLike;
}

export async function detectChatGptProductSurfaces(page: ProductSurfacePageLike): Promise<ProductSurfaceStatus[]> {
    return [
        await detectByText(page, 'chatgpt-projects', ['Projects', 'New project']),
        await detectByText(page, 'chatgpt-library', ['Library', 'Add from library']),
        await detectByText(page, 'chatgpt-apps', ['Apps', 'Connected apps']),
        await detectByText(page, 'chatgpt-deep-research', ['Deep research', '/Deepresearch']),
        await detectBySelector(page, 'canvas', [
            '[data-testid="canvas-panel"]',
            'aside[data-testid*="canvas" i]',
            'section[aria-label*="Canvas" i]',
        ]),
    ];
}

export async function detectGeminiProductSurfaces(page: ProductSurfacePageLike): Promise<ProductSurfaceStatus[]> {
    return [
        await detectByText(page, 'gemini-deep-research', ['Deep Research', 'Start research']),
        await detectBySelector(page, 'canvas', [
            'canvas-panel',
            '[aria-label*="Canvas" i]',
            'div[class*="canvas" i]',
        ]),
    ];
}

async function detectByText(
    page: ProductSurfacePageLike,
    id: ProductSurfaceId,
    texts: string[],
): Promise<ProductSurfaceStatus> {
    const evidence: string[] = [];
    for (const text of texts) {
        const locator = page.getByText?.(text, { exact: false });
        const found = locator ? await locator.first().isVisible().catch(() => false) : false;
        if (found) evidence.push(text);
    }
    return { id, available: evidence.length > 0, evidence, mutationAllowed: false };
}

async function detectBySelector(
    page: ProductSurfacePageLike,
    id: ProductSurfaceId,
    selectors: string[],
): Promise<ProductSurfaceStatus> {
    const evidence: string[] = [];
    for (const selector of selectors) {
        const found = await page.locator(selector).first().isVisible().catch(() => false);
        if (found) evidence.push(selector);
    }
    return { id, available: evidence.length > 0, evidence, mutationAllowed: false };
}

// ── Work/Chat composer-surface detection (parity2 080 slice 8a, C-03) ───────
// Ported from agbrowse product-surfaces.mjs:100-291. Fail-closed: 'ambiguous'
// refuses rather than guesses; legacy (toggle-less) pages consult the
// structured sidebar conversation probe.

import { extractDurableConversationId } from './conversation-url.js';
import { CHATGPT_SURFACE_RADIO_SELECTOR } from './chatgpt-model.js';

export type ChatGptComposerSurface = 'chat' | 'work' | 'ambiguous' | null;
export interface WorkConversationProbe {
    state: 'work' | 'chat' | 'unresolved';
    evidence: Record<string, unknown>;
}
export interface ComposerSurfaceDetection {
    ui: 'toggle' | 'legacy';
    surface: ChatGptComposerSurface;
    evidence: {
        chat: { visible: boolean; checked: boolean | null; dataState: string | null } | null;
        work: { visible: boolean; checked: boolean | null; dataState: string | null } | null;
        conversation?: WorkConversationProbe;
    };
}

type SurfaceAnyNode = any;
declare const location: any;
declare const HTMLElement: any;

/**
 * Browser-context probe. Classifies the CURRENT conversation page as Work or
 * Chat from structured sidebar evidence only: renderer-owned anchors, a
 * structured Work-badge leaf span, same-origin exact-id matching, and POSITIVE
 * chat metadata (absent labels stay unresolved rather than defaulting to Chat).
 */
export function readWorkConversationState({ expectedId }: { expectedId: string }): WorkConversationProbe {
    const normalize = (value: unknown) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const idFromPath = (value: unknown) =>
        (String(value || '').match(/(?:^|\/)c\/([A-Za-z0-9-]+)(?=\/|$)/) || [])[1] || null;
    const isStructuredWorkBadge = (node: SurfaceAnyNode) =>
        node instanceof HTMLElement
        && node.tagName === 'SPAN'
        && normalize(node.textContent) === 'work'
        && node.childElementCount === 0
        && !node.hasAttribute('dir')
        && node.classList.contains('shrink-0')
        && Boolean(node.parentElement?.matches('span.flex.items-center'));

    const conversationId = idFromPath(location.pathname);
    if (!conversationId) return { state: 'unresolved', evidence: { reason: 'not-a-conversation-url' } };
    if (expectedId && conversationId !== expectedId) {
        return { state: 'unresolved', evidence: { reason: 'navigation-race', expectedId, conversationId } };
    }

    const links = (Array.from(document.querySelectorAll('a.__menu-item[href*="/c/"]')) as SurfaceAnyNode[]).filter((node) => {
        try {
            const url = new URL(node.getAttribute('href') || '', location.origin);
            return url.origin === location.origin && idFromPath(url.pathname) === conversationId;
        } catch { return false; }
    });
    if (links.length === 0) {
        return { state: 'unresolved', evidence: { reason: 'conversation-anchor-not-found', conversationId } };
    }
    if (links.some((link) => (Array.from(link.querySelectorAll('span')) as SurfaceAnyNode[]).some(isStructuredWorkBadge))) {
        return { state: 'work', evidence: { conversationId, matched: links.length } };
    }
    const ariaLabels = links.map((link) => normalize(link.getAttribute('aria-label'))).filter(Boolean);
    if (ariaLabels.length === 0 || ariaLabels.some((aria) => /,\s*work\s*$/.test(aria))) {
        return {
            state: 'unresolved',
            evidence: { reason: 'no-positive-chat-metadata', conversationId, matched: links.length },
        };
    }
    return { state: 'chat', evidence: { conversationId, matched: links.length } };
}

/** Node-side wrapper: establishes the conversation id BEFORE evaluating. */
export async function detectChatGptWorkConversation(page: SurfaceAnyNode): Promise<WorkConversationProbe> {
    let conversationId: string | null = null;
    try {
        conversationId = typeof page?.url === 'function' ? extractDurableConversationId(page.url()) : null;
    } catch {
        conversationId = null;
    }
    if (!conversationId) return { state: 'unresolved', evidence: { reason: 'not-a-conversation-url' } };
    if (typeof page?.evaluate !== 'function') {
        return { state: 'unresolved', evidence: { reason: 'probe-unavailable', conversationId } };
    }
    const probe = await page.evaluate(readWorkConversationState, { expectedId: conversationId })
        .catch(() => null);
    return probe && typeof probe.state === 'string'
        ? probe
        : { state: 'unresolved', evidence: { reason: 'probe-failed', conversationId } };
}

async function legacySurfaceDetection(page: SurfaceAnyNode): Promise<ComposerSurfaceDetection> {
    const conversation = await detectChatGptWorkConversation(page);
    const surface: ChatGptComposerSurface = conversation.state === 'work' ? 'work'
        : conversation.state === 'chat' ? 'chat'
        : null;
    return { ui: 'legacy', surface, evidence: { chat: null, work: null, conversation } };
}

/**
 * Read the exact role=radio Chat/Work header buttons, fail-closed:
 *  1. Both radios absent → legacy probe.
 *  2. Both visible, exactly one active with consistent aria-checked + data-state → surface.
 *  3. Attribute mismatch / one-sided / both-active / both-inactive → 'ambiguous'.
 *  4. No mutations.
 */
export async function detectChatGptComposerSurface(page: SurfaceAnyNode): Promise<ComposerSurfaceDetection> {
    const radios = page.locator(CHATGPT_SURFACE_RADIO_SELECTOR);
    const count = await radios.count().catch(() => 0);
    if (count === 0) return legacySurfaceDetection(page);

    const entries: Array<{ text: string; checked: boolean | null; dataState: string | null; visible: boolean }> = [];
    for (let i = 0; i < count; i++) {
        const el = radios.nth(i);
        const visible = await el.isVisible().catch(() => false);
        const text = ((await el.textContent().catch(() => '')) || '').trim();
        const checked = await el.getAttribute('aria-checked').catch(() => null);
        const dataState = await el.getAttribute('data-state').catch(() => null);
        entries.push({
            text,
            checked: checked === 'true' ? true : checked === 'false' ? false : null,
            dataState,
            visible,
        });
    }

    const chat = entries.find((e) => /^chat$/i.test(e.text)) || null;
    const work = entries.find((e) => /^work$/i.test(e.text)) || null;
    if (!chat && !work) return legacySurfaceDetection(page);

    const chatEvid = chat ? { visible: chat.visible, checked: chat.checked, dataState: chat.dataState } : null;
    const workEvid = work ? { visible: work.visible, checked: work.checked, dataState: work.dataState } : null;

    if (!chat || !work || !chat.visible || !work.visible) {
        return { ui: 'toggle', surface: 'ambiguous', evidence: { chat: chatEvid, work: workEvid } };
    }
    const chatActive = chat.checked === true && chat.dataState === 'on';
    const chatInactive = chat.checked === false && chat.dataState === 'off';
    const workActive = work.checked === true && work.dataState === 'on';
    const workInactive = work.checked === false && work.dataState === 'off';
    if (chatActive && workInactive) return { ui: 'toggle', surface: 'chat', evidence: { chat: chatEvid, work: workEvid } };
    if (workActive && chatInactive) return { ui: 'toggle', surface: 'work', evidence: { chat: chatEvid, work: workEvid } };
    return { ui: 'toggle', surface: 'ambiguous', evidence: { chat: chatEvid, work: workEvid } };
}

/** Work availability, independent of whether Work is currently active. */
export async function detectChatGptWorkAvailability(page: SurfaceAnyNode): Promise<{ available: boolean; active: boolean; evidence: ComposerSurfaceDetection }> {
    const detection = await detectChatGptComposerSurface(page);
    const available = detection.evidence.work?.visible === true;
    const active = detection.surface === 'work';
    return { available, active, evidence: detection };
}

