import { createHash, randomUUID } from 'node:crypto';
import { WebAiError } from './errors.js';

export const DEFAULT_SNAPSHOT_MAX_DEPTH = 6;
export const DEFAULT_MAX_NAME_CHARS = 900;
export const DEFAULT_INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab',
    'slider', 'spinbutton', 'treeitem', 'listbox', 'gridcell', 'cell',
]);

export interface AxSnapshotOptions {
    provider?: string | null;
    compact?: boolean;
    interactiveOnly?: boolean;
    maxDepth?: number;
    rootSelector?: string | null;
    refPrefix?: string;
    redactText?: boolean;
    includeDomHash?: boolean;
    domHashMaxChars?: number;
}

export interface AxNode {
    role?: string;
    name?: string;
    checked?: boolean | string;
    disabled?: boolean;
    expanded?: boolean;
    selected?: boolean;
    pressed?: boolean | string;
    level?: number;
    value?: string | number;
    focused?: boolean;
    focusable?: boolean;
    children?: AxNode[];
}

export interface ElementRef {
    ref: string;
    role: string;
    name: string;
    selector: string | null;
    framePath: string[];
    shadowPath: string[];
    signatureHash: string;
}

export interface SerializedSnapshot {
    text: string;
    refs: Record<string, ElementRef>;
    nodeCount: number;
}

export interface WebAiSnapshot {
    snapshotId: string;
    provider: string | null;
    url: string | null;
    domHash: string | null;
    axHash: string;
    text: string;
    refs: Record<string, ElementRef>;
    stats: {
        nodeCount: number;
        interactiveCount: number;
        tokenEstimate: number;
    };
}

export interface SnapshotStats {
    nodeCount: number;
    interactiveCount: number;
    tokenEstimate: number;
}

export interface SummarizeOptions {
    maxRefs?: number;
}

export interface SummarizeResult {
    enabled: boolean;
    contentSafe: boolean;
    snapshotId: string | null;
    axHash: string | null;
    domHash: string | null;
    interactiveCount: number;
    tokenEstimate: number;
    topRefs: Array<{
        ref: string;
        role: string;
        nameHash: string | null;
        nameChars: number;
    }>;
}

export interface AxSnapshotPageLike {
    url?: () => string | null;
    accessibility?: {
        snapshot: (opts?: { interestingOnly?: boolean; root?: unknown }) => Promise<AxNode>;
    };
    locator: (selector: string) => {
        elementHandle: () => Promise<{ dispose?: () => Promise<void> } | null>;
    };
    evaluate: <T, A>(fn: (arg: A) => T | null, arg: A) => Promise<T | null>;
}

export async function buildWebAiSnapshot(
    page: AxSnapshotPageLike,
    {
        provider = null,
        compact = true,
        interactiveOnly = true,
        maxDepth = DEFAULT_SNAPSHOT_MAX_DEPTH,
        rootSelector = null,
        refPrefix = '@e',
        redactText = false,
        includeDomHash = true,
        domHashMaxChars = 32768,
    }: AxSnapshotOptions = {},
): Promise<WebAiSnapshot> {
    const tree = await captureAccessibilitySnapshot(page, { interactiveOnly, rootSelector });
    const serialized = serializeAxTree(tree, { compact, maxDepth, refPrefix, redactText });
    let domHash: string | null = null;
    if (includeDomHash) {
        try {
            domHash = await domHashAround(page, rootSelector ? [rootSelector] : ['body'], { maxChars: domHashMaxChars });
        } catch {
            domHash = null;
        }
    }
    const text = serialized.text || '- document';
    return {
        snapshotId: randomUUID(),
        provider,
        url: page.url?.() || null,
        domHash,
        axHash: hashAccessibilitySnapshot(text),
        text,
        refs: serialized.refs,
        stats: {
            nodeCount: serialized.nodeCount,
            interactiveCount: Object.keys(serialized.refs).length,
            tokenEstimate: estimateSnapshotTokens(text),
        },
    };
}

export function estimateSnapshotTokens(snapshotText: string | null | undefined): number {
    return Math.ceil(String(snapshotText || '').length / 4);
}

export function hashAccessibilitySnapshot(snapshotText: string | null | undefined): string {
    const normalized = String(snapshotText || '').replace(/\s+/g, ' ').trim();
    return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export function extractInteractiveRefs(snapshot: WebAiSnapshot | AxNode, prefix = '@e'): Record<string, ElementRef> {
    if (snapshot && typeof snapshot === 'object' && 'refs' in snapshot && !('role' in snapshot)) {
        return { ...(snapshot as WebAiSnapshot).refs };
    }
    const refs: Record<string, ElementRef> = {};
    let counter = 1;
    walkAx(snapshot as AxNode, (node, depth, path) => {
        if (!isInteractiveNode(node)) return;
        const ref = `${prefix}${counter++}`;
        const name = truncateName(node.name || '');
        refs[ref] = {
            ref,
            role: String(node.role || 'unknown'),
            name,
            selector: null,
            framePath: [],
            shadowPath: [],
            signatureHash: hashElementSignature({ role: node.role, name, depth, path }),
        };
    });
    return refs;
}

export function summarizeSnapshotForDoctor(snapshot: WebAiSnapshot | null | undefined, { maxRefs = 8 }: SummarizeOptions = {}): SummarizeResult {
    const refs = Object.values(snapshot?.refs || {}).slice(0, maxRefs);
    return {
        enabled: true,
        contentSafe: true,
        snapshotId: snapshot?.snapshotId || null,
        axHash: snapshot?.axHash || null,
        domHash: snapshot?.domHash || null,
        interactiveCount: snapshot?.stats?.interactiveCount || 0,
        tokenEstimate: snapshot?.stats?.tokenEstimate || 0,
        topRefs: refs.map(ref => ({
            ref: ref.ref,
            role: ref.role,
            nameHash: ref.name ? hashDoctorField(ref.name) : null,
            nameChars: ref.name ? ref.name.length : 0,
        })),
    };
}

async function captureAccessibilitySnapshot(
    page: AxSnapshotPageLike,
    { interactiveOnly, rootSelector }: { interactiveOnly: boolean; rootSelector: string | null },
): Promise<AxNode> {
    if (!page?.accessibility || typeof page.accessibility.snapshot !== 'function') {
        throw new WebAiError({
            errorCode: 'snapshot.unavailable',
            stage: 'snapshot-capture',
            retryHint: 'pin-playwright-or-add-cdp-fallback',
            message: 'page.accessibility.snapshot() is not available in this Playwright runtime',
        });
    }
    let root: { dispose?: () => Promise<void> } | null = null;
    try {
        if (rootSelector) {
            root = await page.locator(rootSelector).elementHandle().catch(() => null);
            if (!root) {
                throw new WebAiError({
                    errorCode: 'snapshot.root-not-found',
                    stage: 'snapshot-capture',
                    retryHint: 'fix-root-selector',
                    message: `snapshot root selector did not match: ${rootSelector}`,
                    evidence: { rootSelector },
                });
            }
        }
        return await page.accessibility.snapshot({
            interestingOnly: interactiveOnly,
            ...(root ? { root } : {}),
        }) as AxNode;
    } finally {
        await root?.dispose?.().catch(() => undefined);
    }
}

interface SerializeCtx {
    compact: boolean;
    maxDepth: number;
    refPrefix: string;
    redactText: boolean;
    refs: Record<string, ElementRef>;
    nextRef: number;
    nodeCount: number;
}

function serializeAxTree(tree: AxNode, options: Omit<SerializeCtx, 'refs' | 'nextRef' | 'nodeCount'>): SerializedSnapshot {
    const ctx: SerializeCtx = { ...options, refs: {}, nextRef: 1, nodeCount: 0 };
    const lines = serializeNode(tree || { role: 'document', name: '' }, 0, ctx, []);
    return { text: lines.join('\n'), refs: ctx.refs, nodeCount: ctx.nodeCount };
}

function serializeNode(node: AxNode, depth: number, ctx: SerializeCtx, path: number[]): string[] {
    if (!node || depth > ctx.maxDepth) return [];
    ctx.nodeCount += 1;
    const role = sanitizeRole(node.role || 'generic');
    const rawName = truncateName(node.name || '');
    const name = ctx.redactText && rawName ? `[redacted:${hashDoctorField(rawName)}]` : rawName;
    const indent = '  '.repeat(depth);
    const attrs: string[] = [];

    if (isInteractiveNode(node)) {
        const ref = `${ctx.refPrefix}${ctx.nextRef++}`;
        attrs.push(`ref=${ref}`);
        ctx.refs[ref] = {
            ref, role, name: rawName,
            selector: null, framePath: [], shadowPath: [],
            signatureHash: hashElementSignature({ role, name: rawName, depth, path }),
        };
    }
    for (const attr of ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'level', 'value'] as const) {
        const val = node[attr];
        if (val !== undefined && val !== null && val !== '') {
            attrs.push(`${attr}=${formatAttrValue(val)}`);
        }
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const singleText = ctx.compact ? singleTextChild(node) : null;

    if (role === 'text') return [`${indent}- text: ${quoteAxString(name)}`];

    if (singleText && !name) {
        const renderedText = ctx.redactText ? `[redacted:${hashDoctorField(singleText)}]` : truncateName(singleText);
        return [`${indent}- ${role}: ${quoteAxString(renderedText)}${attrs.length ? ` [${attrs.join(' ')}]` : ''}`];
    }

    const head = `${indent}- ${role}${name ? ` ${quoteAxString(name)}` : ''}${attrs.length ? ` [${attrs.join(' ')}]` : ''}${children.length ? ':' : ''}`;
    const out: string[] = [head];
    children.forEach((child, index) => out.push(...serializeNode(child, depth + 1, ctx, [...path, index])));
    return out;
}

function walkAx(node: AxNode | null | undefined, visit: (node: AxNode, depth: number, path: number[]) => void, depth = 0, path: number[] = []): void {
    if (!node) return;
    visit(node, depth, path);
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, index) => walkAx(child, visit, depth + 1, [...path, index]));
}

function isInteractiveNode(node: AxNode): boolean {
    if (!node?.role) return false;
    if (DEFAULT_INTERACTIVE_ROLES.has(String(node.role))) return true;
    return node.focused === true || node.focusable === true;
}

function singleTextChild(node: AxNode): string | null {
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length !== 1) return null;
    const child = children[0];
    if (child?.role !== 'text' || !child.name) return null;
    return child.name;
}

function truncateName(value: unknown, max = DEFAULT_MAX_NAME_CHARS): string {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function sanitizeRole(role: string): string {
    return String(role || 'generic').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function quoteAxString(value: string | number | boolean | undefined | null): string {
    return JSON.stringify(String(value || ''));
}

function formatAttrValue(value: string | number | boolean | undefined | null): string {
    if (typeof value === 'string') return JSON.stringify(truncateName(value, 120));
    return String(value);
}

function hashElementSignature(input: Record<string, unknown>): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;
}

export function hashDoctorField(value: string | number | boolean | undefined | null): string {
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

async function domHashAround(
    page: AxSnapshotPageLike,
    selectors: string[],
    options: { maxChars?: number } = {},
): Promise<string | null> {
    const maxChars = options.maxChars ?? 8192;
    const html = await page.evaluate((sels: string[]) => {
        for (const s of sels) {
            try {
                const n = (globalThis as any).document.querySelector(s);
                if (n) return (n as any).outerHTML;
            } catch {
                // invalid selector
            }
        }
        return null;
    }, selectors).catch(() => null);
    if (!html) return null;
    return `sha256:${createHash('sha256').update(normalizeDomForHash(html).slice(0, maxChars)).digest('hex').slice(0, 16)}`;
}

function normalizeDomForHash(html: string): string {
    return String(html)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(\w+)\s[^>]*>/g, '<$1>')
        .replace(/>([^<]+)</g, '><')
        .replace(/\s+/g, ' ')
        .trim();
}
