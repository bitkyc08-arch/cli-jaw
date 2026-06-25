/**
 * G06 — observation-bundle: pure assembler for ObservationBundleV1.
 * Mirrors agbrowse `web-ai/observation-bundle.mjs`.
 *
 * No hosted/cloud, no stealth, no CAPTCHA bypass, no external CDP.
 */

export interface ObservationBundleSnapshotNode {
    ref: string;
    role: string;
    name?: string;
    depth?: number;
    occurrenceIndex?: number;
}

export interface ObservationBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ObservationBundleInput {
    url: string;
    title?: string;
    viewport: { width: number; height: number };
    dpr?: number;
    snapshotNodes: ObservationBundleSnapshotNode[];
    boxes?: Record<string, ObservationBox>;
    screenshotPath?: string | null;
    textSummary?: string;
    maxTextChars?: number;
    capturedAt?: string;
    observationId?: string;
    targetId?: string;
}

export interface ObservationBundleRef {
    ref: string;
    role: string;
    name: string;
    depth: number;
    occurrenceIndex?: number;
    box?: ObservationBox;
}

export interface ObservationBundleV1 {
    schemaVersion: 'observation-bundle-v1';
    observationId: string;
    targetId: string;
    url: string;
    title: string;
    viewport: { width: number; height: number };
    dpr: number;
    capturedAt: string;
    refs: ObservationBundleRef[];
    screenshot: string | null;
    textSummary: string;
    basis: { url: string; targetId: string; viewport: { width: number; height: number }; dpr: number; capturedAt: string };
    stats: { refCount: number; boxCount: number; textChars: number; hasScreenshot: boolean };
}

function isElementRef(ref: string): boolean {
    return /^@?e\d+$/.test(ref);
}

/** FNV-1a hash of (url, capturedAt, refCount) for a stable default observationId. */
function hashBasis(url: string, capturedAt: string, refCount: number): string {
    let hash = 2166136261;
    const input = `${url}|${capturedAt}|${refCount}`;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

const SCHEMA_VERSION = 'observation-bundle-v1' as const;
const DEFAULT_MAX_TEXT_CHARS = 2000;

function clampText(s: string, max?: number): string {
    const limit = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_TEXT_CHARS;
    const str = String(s || '');
    if (str.length <= limit) return str;
    return `${str.slice(0, limit - 3)}...`;
}

export function buildObservationBundle(input: ObservationBundleInput): ObservationBundleV1 {
    if (!input || typeof input !== 'object') throw new Error('buildObservationBundle: input is required');
    if (typeof input.url !== 'string' || input.url.length === 0) {
        throw new Error('buildObservationBundle: input.url is required (string)');
    }
    if (!input.viewport || typeof input.viewport.width !== 'number' || typeof input.viewport.height !== 'number') {
        throw new Error('buildObservationBundle: input.viewport {width,height} is required');
    }
    if (!Array.isArray(input.snapshotNodes)) {
        throw new Error('buildObservationBundle: input.snapshotNodes must be an array');
    }
    const boxes = input.boxes && typeof input.boxes === 'object' ? input.boxes : {};
    const refs: ObservationBundleRef[] = [];
    for (const node of input.snapshotNodes) {
        if (!node || typeof node.ref !== 'string') continue;
        // 104.22: accept bare or @-prefixed element refs (@?e\d+); reject non-element refs like @x.
        if (!isElementRef(node.ref)) continue;
        const row: ObservationBundleRef = {
            ref: node.ref,
            role: String(node.role || ''),
            name: String(node.name || ''),
            depth: typeof node.depth === 'number' ? node.depth : 0,
        };
        if (typeof node.occurrenceIndex === 'number') row.occurrenceIndex = node.occurrenceIndex;
        const box = boxes[node.ref];
        if (
            box &&
            [box.x, box.y, box.width, box.height].every((n) => typeof n === 'number' && Number.isFinite(n))
        ) {
            row.box = { x: box.x, y: box.y, width: box.width, height: box.height };
        }
        refs.push(row);
    }
    const dpr = typeof input.dpr === 'number' && input.dpr > 0 ? input.dpr : 1;
    const textSummary = clampText(input.textSummary || '', input.maxTextChars);
    const screenshot = input.screenshotPath || null;
    const capturedAt = input.capturedAt || new Date().toISOString();
    let boxCount = 0;
    for (const r of refs) if (r.box) boxCount += 1;
    const targetId = input.targetId || '';
    const observationId = input.observationId || `obs-${hashBasis(input.url, capturedAt, refs.length)}`;
    return {
        schemaVersion: SCHEMA_VERSION,
        observationId,
        targetId,
        url: input.url,
        title: String(input.title || ''),
        viewport: { width: input.viewport.width, height: input.viewport.height },
        dpr,
        capturedAt,
        refs,
        screenshot,
        textSummary,
        basis: {
            url: input.url,
            targetId,
            viewport: { width: input.viewport.width, height: input.viewport.height },
            dpr,
            capturedAt,
        },
        stats: {
            refCount: refs.length,
            boxCount,
            textChars: textSummary.length,
            hasScreenshot: Boolean(screenshot),
        },
    };
}

export function formatObservationBundle(bundle: ObservationBundleV1): string {
    const lines = [
        `observation-bundle-v1  url=${JSON.stringify(bundle.url)}  title=${JSON.stringify(bundle.title)}`,
        `  viewport=${bundle.viewport.width}x${bundle.viewport.height} dpr=${bundle.dpr}  refs=${bundle.stats.refCount}  boxes=${bundle.stats.boxCount}  text=${bundle.stats.textChars}ch  screenshot=${bundle.stats.hasScreenshot ? bundle.screenshot : '∅'}`,
    ];
    for (const r of bundle.refs.slice(0, 20)) {
        const box = r.box ? `  box=${r.box.x},${r.box.y},${r.box.width}x${r.box.height}` : '';
        lines.push(`  ${r.ref.padEnd(4)} ${r.role.padEnd(10)} ${JSON.stringify(r.name)}${box}`);
    }
    if (bundle.refs.length > 20) lines.push(`  ... ${bundle.refs.length - 20} more refs`);
    return lines.join('\n');
}

export const OBSERVATION_BUNDLE_SCHEMA_VERSION = SCHEMA_VERSION;
