import { contentHash, getRenderCache } from '../render-cache.js';
import { sanitizeHtml, sanitizePolicyVersion, type SanitizedHtml } from '../sanitize-policy.js';
import { getMermaidInitConfig, type ResolvedTheme } from './mermaid-config.js';
import { preprocessMermaid, sanitizeMermaidForRetry } from './mermaid-preprocess.js';

export const mermaidVersion = '11.16.0';
export const MERMAID_AUTO_SOURCE_LIMIT = 128 * 1024;

interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, source: string): Promise<{ svg: string }>;
}
export interface MermaidRenderRequest {
    source: string;
    resolvedTheme: ResolvedTheme;
    generation: number;
    isCurrent?: (generation: number, resolvedTheme: ResolvedTheme) => boolean;
    explicit?: boolean;
}
export type MermaidRenderResult =
    | { status: 'ready'; svg: SanitizedHtml; cacheKey: string; cached: boolean }
    | { status: 'error'; error: string; escapedSource: string }
    | { status: 'oversize'; notice: string; escapedSource: string }
    | { status: 'stale' };

let modulePromise: Promise<MermaidApi> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderOrdinal = 0;

function loadMermaid(): Promise<MermaidApi> {
    modulePromise ??= import('mermaid').then(module => module.default as unknown as MermaidApi);
    return modulePromise;
}

function escapeHtml(source: string): string {
    return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function mermaidCacheKey(source: string, resolvedTheme: ResolvedTheme): string {
    return `${contentHash(source)}:${resolvedTheme}:${mermaidVersion}:${sanitizePolicyVersion}`;
}

function errorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        const candidate = error as { message?: unknown; str?: unknown };
        if (typeof candidate.message === 'string') return candidate.message.slice(0, 200);
        if (typeof candidate.str === 'string') return candidate.str.slice(0, 200);
    }
    return String(error || 'Unknown error').slice(0, 200);
}

async function performRender(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
    const escapedSource = escapeHtml(request.source);
    if (request.isCurrent && !request.isCurrent(request.generation, request.resolvedTheme)) return { status: 'stale' };
    if (!request.explicit && new TextEncoder().encode(request.source).byteLength > MERMAID_AUTO_SOURCE_LIMIT) {
        return { status: 'oversize', notice: 'Diagram exceeds 128 KiB. Render explicitly to continue.', escapedSource };
    }
    const cacheKey = mermaidCacheKey(request.source, request.resolvedTheme);
    const cache = getRenderCache();
    const cached = cache.getEmbed('mermaid', cacheKey);
    if (typeof cached === 'string') {
        if (request.isCurrent && !request.isCurrent(request.generation, request.resolvedTheme)) return { status: 'stale' };
        return { status: 'ready', svg: cached as SanitizedHtml, cacheKey, cached: true };
    }
    const source = preprocessMermaid(request.source);
    try {
        const mermaid = await loadMermaid();
        mermaid.initialize(getMermaidInitConfig(request.resolvedTheme));
        let svg: string;
        try {
            ({ svg } = await mermaid.render(`d2-mermaid-${++renderOrdinal}`, source));
        } catch (firstError) {
            const retry = sanitizeMermaidForRetry(source);
            if (!retry) throw firstError;
            mermaid.initialize(getMermaidInitConfig(request.resolvedTheme));
            ({ svg } = await mermaid.render(`d2-mermaid-${++renderOrdinal}-retry`, retry));
        }
        if (request.isCurrent && !request.isCurrent(request.generation, request.resolvedTheme)) return { status: 'stale' };
        const sanitized = sanitizeHtml(svg, 'mermaid-svg');
        cache.setEmbed('mermaid', cacheKey, sanitized);
        return { status: 'ready', svg: sanitized, cacheKey, cached: false };
    } catch (error) {
        if (request.isCurrent && !request.isCurrent(request.generation, request.resolvedTheme)) return { status: 'stale' };
        return { status: 'error', error: errorMessage(error), escapedSource };
    }
}

export function renderMermaid(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
    let resolveResult!: (value: MermaidRenderResult) => void;
    const result = new Promise<MermaidRenderResult>(resolve => { resolveResult = resolve; });
    renderQueue = renderQueue.then(async () => { resolveResult(await performRender(request)); }).catch((error) => {
        resolveResult({ status: 'error', error: errorMessage(error), escapedSource: escapeHtml(request.source) });
    });
    return result;
}

export function resetMermaidRuntimeForTests(): void {
    modulePromise = null; renderQueue = Promise.resolve(); renderOrdinal = 0;
}
