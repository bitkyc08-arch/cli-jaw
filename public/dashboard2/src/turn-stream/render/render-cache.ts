import type { SanitizedHtml } from './sanitize-policy.js';
import { sanitizePolicyVersion } from './sanitize-policy.js';

export const rendererVersion = 'r1.1';
export const shikiVersion = '4.3.1';
export const grammarBundle = 'bash,cpp,css,diff,go,html,java,javascript,json,jsx,markdown,plaintext,python,rust,sql,tsx,typescript,yaml@4.3.1';
export const transformerVersion = 'semantic-v1';
export const katexVersion = '0.16.44';

type PoolName = 'markdown' | 'embed' | 'highlight' | 'height';
type CacheValue = string | number | SanitizedHtml;
interface Entry { value: CacheValue; bytes: number; pins: Set<string> }

const LIMITS: Record<PoolName, { count: number; bytes: number }> = {
    markdown: { count: 256, bytes: 16 * 1024 * 1024 },
    embed: { count: 128, bytes: 8 * 1024 * 1024 },
    highlight: { count: 128, bytes: 4 * 1024 * 1024 },
    height: { count: 10_000, bytes: 2 * 1024 * 1024 },
};

class ByteLru {
    readonly entries = new Map<string, Entry>();
    totalBytes = 0;
    constructor(readonly limit: { count: number; bytes: number }) {}
    get(key: string): CacheValue | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key); this.entries.set(key, entry);
        return entry.value;
    }
    set(key: string, value: CacheValue, bytes = estimateBytes(value)): boolean {
        if (bytes > this.limit.bytes / 4) return false;
        const old = this.entries.get(key);
        if (old) { this.totalBytes -= old.bytes; this.entries.delete(key); }
        this.entries.set(key, { value, bytes, pins: old?.pins ?? new Set() });
        this.totalBytes += bytes;
        this.evict();
        return this.entries.has(key);
    }
    pin(key: string, scope: string): void { this.entries.get(key)?.pins.add(scope); }
    unpinScope(scope: string): void { for (const entry of this.entries.values()) entry.pins.delete(scope); this.evict(); }
    private evict(): void {
        while (this.entries.size > this.limit.count || this.totalBytes > this.limit.bytes) {
            const victim = [...this.entries].find(([, entry]) => entry.pins.size === 0);
            if (!victim) return;
            this.entries.delete(victim[0]); this.totalBytes -= victim[1].bytes;
        }
    }
}

function estimateBytes(value: CacheValue): number {
    return typeof value === 'string' ? value.length * 2 : 8;
}

export class RenderCacheManager {
    private readonly pools = Object.fromEntries(
        Object.entries(LIMITS).map(([name, limit]) => [name, new ByteLru(limit)]),
    ) as Record<PoolName, ByteLru>;
    private scopeKey: string | null = null;
    private live: { scopeKey: string; key: string; value: SanitizedHtml } | null = null;

    get(pool: PoolName, key: string): CacheValue | undefined { return this.pools[pool].get(key); }
    set(pool: PoolName, key: string, value: CacheValue, bytes?: number): boolean {
        if (this.estimatedBytes() + (bytes ?? estimateBytes(value)) > 32 * 1024 * 1024) return false;
        return this.pools[pool].set(key, value, bytes);
    }
    setIfGenerationCurrent(pool: PoolName, key: string, value: CacheValue, generation: number, currentGeneration: () => number, bytes?: number): boolean {
        return generation === currentGeneration() && this.set(pool, key, value, bytes);
    }
    pin(pool: PoolName, key: string): void { if (this.scopeKey) this.pools[pool].pin(key, this.scopeKey); }
    unpin(pool: PoolName, key: string): void {
        const entry = this.pools[pool].entries.get(key);
        if (entry && this.scopeKey) entry.pins.delete(this.scopeKey);
    }
    setScope(scopeKey: string): void { if (scopeKey !== this.scopeKey) { this.releaseScope(); this.scopeKey = scopeKey; } }
    releaseScope(): void {
        if (this.scopeKey) for (const pool of Object.values(this.pools)) pool.unpinScope(this.scopeKey);
        this.scopeKey = null; this.live = null;
    }
    setLiveMarkdown(scopeKey: string, key: string, value: SanitizedHtml): void { this.live = { scopeKey, key, value }; }
    getLiveMarkdown(scopeKey: string): { key: string; value: SanitizedHtml } | null {
        return this.live?.scopeKey === scopeKey ? { key: this.live.key, value: this.live.value } : null;
    }
    clearLiveMarkdown(scopeKey?: string): void { if (!scopeKey || this.live?.scopeKey === scopeKey) this.live = null; }
    stats(pool: PoolName): { count: number; bytes: number } {
        return { count: this.pools[pool].entries.size, bytes: this.pools[pool].totalBytes };
    }
    estimatedBytes(): number { return Object.values(this.pools).reduce((sum, pool) => sum + pool.totalBytes, 0); }
}

let singleton: RenderCacheManager | null = null;
export function getRenderCache(): RenderCacheManager { return singleton ??= new RenderCacheManager(); }

export function contentHash(source: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}
export function markdownCacheKey(hash: string): string { return `${hash}:${rendererVersion}:${sanitizePolicyVersion}`; }
export function highlightCacheKey(codeHash: string, language: string): string {
    return `${codeHash}:${language}:${shikiVersion}:${grammarBundle}:${transformerVersion}`;
}
export function embedCacheKey(texHash: string, displayMode: boolean): string {
    return `${texHash}:${displayMode}:${katexVersion}`;
}
export function heightCacheKey(parts: { threadId: string; turnId: string; contentRevision: number; widthPx: number; fontMetricsVersion: string; fontScale: number; expansionFingerprint: string }): string {
    const widthBucket = Math.floor(parts.widthPx / 64) * 64;
    return [parts.threadId, parts.turnId, parts.contentRevision, widthBucket, parts.fontMetricsVersion,
        parts.fontScale, rendererVersion, parts.expansionFingerprint].join(':');
}
