import { trySaveFileArtifact } from './session-artifacts.js';
import { appendSessionArtifact } from './session.js';
import type { WebAiArtifactDescriptor } from './types.js';

/**
 * Generic ChatGPT downloadable-file artifact capture. Strict-TS port of agbrowse
 * web-ai/chatgpt-files.mjs (parity catalog 101 #1, P0).
 *
 * Trust boundary: the browser DOM (assistant turn) provides untrusted URLs. Only known
 * ChatGPT file endpoints on the ChatGPT origin are accepted; path traversal, foreign
 * hosts, non-HTTPS, ports, and unsafe schemes are rejected.
 */

interface CdpSession {
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface RawDownloadCandidate {
    href?: string;
    download?: string;
    text?: string;
}

export interface DownloadCandidate {
    sourceUrl: string;
    download: string;
    text: string;
}

/** Hosts that may serve ChatGPT downloadable files. */
const ALLOWED_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const DEFAULT_ORIGIN = 'https://chatgpt.com';
/** `/backend-api/files/<id>/download` or `/content` (id is opaque, charset-limited). */
const FILES_PATH = /^\/backend-api\/files\/[A-Za-z0-9_-]+\/(download|content)$/;

function hasUnsafeChars(s: string): boolean {
    return s.includes('\0') || s.includes('\\');
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function containsTraversal(s: string): boolean {
    if (typeof s !== 'string') return true;
    return s.includes('..') || safeDecode(s).includes('..');
}

/** Validate a `/mnt/data/...` sandbox path: under `/mnt/data/` with no traversal. */
function isSafeSandboxPath(p: string): boolean {
    if (typeof p !== 'string' || p === '') return false;
    if (hasUnsafeChars(p) || containsTraversal(p)) return false;
    return p.startsWith('/mnt/data/');
}

function isAllowedFileEndpoint(u: URL): boolean {
    const p = u.pathname;
    if (p === '/backend-api/sandbox/download') {
        const pathParam = u.searchParams.get('path');
        return pathParam !== null && isSafeSandboxPath(pathParam);
    }
    if (FILES_PATH.test(p)) return true;
    if (p === '/backend-api/estuary/content') {
        const id = u.searchParams.get('id');
        return id !== null && /^file_[A-Za-z0-9_-]+$/.test(id);
    }
    return false;
}

/** Convert a safe `sandbox:/mnt/data/...` reference into an absolute download URL, else null. */
export function normalizeChatGptSandboxUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw.toLowerCase().startsWith('sandbox:')) return null;
    const p = raw.slice('sandbox:'.length);
    if (!isSafeSandboxPath(p)) return null;
    const u = new URL('/backend-api/sandbox/download', DEFAULT_ORIGIN);
    u.searchParams.set('path', p);
    return u.toString();
}

/**
 * Normalize and validate a ChatGPT downloadable-file URL from the DOM. Returns the
 * canonical absolute URL string, or null if it is not a known, safe ChatGPT endpoint.
 */
export function normalizeChatGptFileDownloadUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (raw === '' || hasUnsafeChars(raw)) return null;
    if (raw.toLowerCase().startsWith('sandbox:')) return normalizeChatGptSandboxUrl(raw);

    let u: URL;
    try {
        u = raw.startsWith('/') ? new URL(raw, DEFAULT_ORIGIN) : new URL(raw);
    } catch {
        return null;
    }
    if (u.protocol !== 'https:') return null;
    if (!ALLOWED_HOSTS.has(u.hostname)) return null;
    if (u.port !== '') return null;
    if (containsTraversal(u.pathname)) return null;
    if (!isAllowedFileEndpoint(u)) return null;
    return u.toString();
}

const CONVERSATION_TURN_SELECTOR = 'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"]';
const ASSISTANT_ROOT_SELECTOR = '[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant" i]';
const FILENAME_FALLBACK_PREFIX = 'chatgpt-file';

/**
 * Build the in-page expression that harvests candidate download anchors from assistant
 * turns after `baselineAssistantCount`. Endpoint allowlisting happens in Node.
 */
export function buildDownloadableFileDetectionExpression(baselineAssistantCount = 0): string {
    const minIdx = Number.isFinite(Number(baselineAssistantCount))
        ? Math.max(0, Math.floor(Number(baselineAssistantCount)))
        : 0;
    return `(() => {
        const MIN_ASSISTANT_INDEX = ${minIdx};
        const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
        const ASSISTANT_SELECTOR = ${JSON.stringify(ASSISTANT_ROOT_SELECTOR)};
        const isAssistantTurn = (node) => {
            if (!(node instanceof HTMLElement)) return false;
            if (String(node.getAttribute('data-turn') || '').toLowerCase() === 'assistant') return true;
            if (String(node.getAttribute('data-message-author-role') || '').toLowerCase() === 'assistant') return true;
            if (String(node.getAttribute('data-testid') || '').toLowerCase().includes('assistant')) return true;
            return Boolean(node.querySelector(ASSISTANT_SELECTOR));
        };
        const pushUniqueRoot = (roots, node) => {
            if (!(node instanceof HTMLElement)) return;
            if (roots.some(root => root === node || root.contains(node))) return;
            for (let i = roots.length - 1; i >= 0; i -= 1) {
                if (node.contains(roots[i])) roots.splice(i, 1);
            }
            roots.push(node);
        };
        const roots = [];
        for (const node of document.querySelectorAll(CONVERSATION_SELECTOR)) {
            if (isAssistantTurn(node)) pushUniqueRoot(roots, node);
        }
        for (const node of document.querySelectorAll(ASSISTANT_SELECTOR)) {
            if (isAssistantTurn(node)) pushUniqueRoot(roots, node);
        }
        roots.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
        const relevant = roots.slice(MIN_ASSISTANT_INDEX);
        const out = [];
        for (const msg of relevant) {
            for (const a of msg.querySelectorAll('a[href], a[download]')) {
                const href = a.getAttribute('href') || '';
                if (!href) continue;
                out.push({
                    href,
                    download: a.getAttribute('download') || '',
                    text: String(a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
                });
            }
        }
        return out;
    })()`;
}

/** Deduplicate raw candidates by normalized ChatGPT file URL; drop non-allowlisted hrefs. */
export function dedupeDownloadCandidates(candidates: RawDownloadCandidate[]): DownloadCandidate[] {
    const seen = new Set<string>();
    const out: DownloadCandidate[] = [];
    for (const c of Array.isArray(candidates) ? candidates : []) {
        const sourceUrl = normalizeChatGptFileDownloadUrl(c?.href);
        if (!sourceUrl || seen.has(sourceUrl)) continue;
        seen.add(sourceUrl);
        out.push({ sourceUrl, download: String(c?.download || ''), text: String(c?.text || '') });
    }
    return out;
}

/** Reduce an arbitrary candidate filename to a safe basename. */
export function sanitizeDownloadFilename(name: unknown): string {
    if (typeof name !== 'string') return '';
    const base = (name.split(/[\\/]/).pop() || '').replace(/\0/g, '');
    const cleaned = base.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
    return cleaned === '' || cleaned === '.' ? '' : cleaned;
}

/** Extract a filename from a `Content-Disposition` header (filename* preferred). */
export function filenameFromContentDisposition(headerValue: unknown): string | null {
    if (typeof headerValue !== 'string' || headerValue === '') return null;
    const star = headerValue.match(/filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i);
    const starCap = star?.[1];
    if (starCap) {
        try {
            const safe = sanitizeDownloadFilename(decodeURIComponent(starCap.trim().replace(/^"|"$/g, '')));
            if (safe) return safe;
        } catch { /* fall through to plain filename */ }
    }
    const plain = headerValue.match(/filename\s*=\s*"?([^";]+)"?/i);
    const plainCap = plain?.[1];
    if (plainCap) {
        const safe = sanitizeDownloadFilename(plainCap.trim());
        if (safe) return safe;
    }
    return null;
}

function filenameFromUrl(url: string): string {
    if (typeof url !== 'string') return '';
    try {
        const u = new URL(url);
        const sandboxPath = u.searchParams.get('path');
        if (sandboxPath) return sanitizeDownloadFilename(sandboxPath.split('/').pop() || '');
        const last = u.pathname.split('/').filter(Boolean).pop() || '';
        if (last === 'download' || last === 'content') return '';
        return sanitizeDownloadFilename(last);
    } catch {
        return '';
    }
}

/** Resolve the saved filename: Content-Disposition → download attr → URL basename → fallback. */
export function resolveDownloadFilename(opts: {
    contentDisposition?: string | null;
    downloadAttr?: string;
    sourceUrl?: string;
    index?: number;
} = {}): string {
    const { contentDisposition, downloadAttr, sourceUrl, index = 0 } = opts;
    const fromCd = filenameFromContentDisposition(contentDisposition);
    if (fromCd) return fromCd;
    const fromAttr = sanitizeDownloadFilename(downloadAttr || '');
    if (fromAttr) return fromAttr;
    const fromUrl = filenameFromUrl(sourceUrl || '');
    if (fromUrl) return fromUrl;
    return `${FILENAME_FALLBACK_PREFIX}-${index + 1}`;
}

/** Scan assistant turns after the baseline; return deduped, allowlisted candidates. */
export async function readAssistantDownloadableFiles(
    cdpSession: CdpSession,
    opts: { baselineAssistantCount?: number } = {},
): Promise<DownloadCandidate[]> {
    const evalRes = (await cdpSession.send('Runtime.evaluate', {
        expression: buildDownloadableFileDetectionExpression(opts.baselineAssistantCount ?? 0),
        returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = evalRes.result?.value;
    let raw: unknown;
    try {
        raw = Array.isArray(value) ? value : JSON.parse(typeof value === 'string' ? value : '[]');
    } catch {
        return [];
    }
    return dedupeDownloadCandidates(Array.isArray(raw) ? (raw as RawDownloadCandidate[]) : []);
}

const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DEFAULT_PER_DOWNLOAD_TIMEOUT_MS = 30_000;

type FetchDownloadResult =
    | { buffer: Buffer; mimeType: string; contentDisposition: string | null }
    | { timedOut: true }
    | { failed: true };

async function getChatGptCookieHeader(cdpSession: CdpSession): Promise<string> {
    try {
        const res = (await cdpSession.send('Network.getCookies', { urls: ['https://chatgpt.com/'] })) as {
            cookies?: Array<{ name: string; value: string }>;
        };
        return (res.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
        return '';
    }
}

async function fetchDownload(url: string, cookieHeader: string, timeoutMs: number): Promise<FetchDownloadResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            headers: { Cookie: cookieHeader, 'User-Agent': DOWNLOAD_USER_AGENT },
            redirect: 'follow',
            signal: controller.signal,
        });
        if (!resp.ok) return { failed: true };
        const contentDisposition = resp.headers.get('content-disposition');
        const mimeType = (resp.headers.get('content-type') || 'application/octet-stream').split(';')[0]?.trim()
            || 'application/octet-stream';
        const buffer = Buffer.from(await resp.arrayBuffer());
        return { buffer, mimeType, contentDisposition };
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') return { timedOut: true };
        return { failed: true };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Capture generic downloadable files from the current assistant turn and persist them as
 * `kind:'file'` session artifacts. Downloads run sequentially; once one times out,
 * attribution stops so a late completion is never attached to the next candidate.
 */
export async function saveAssistantDownloadableFiles(
    cdpSession: CdpSession,
    _deps: unknown,
    opts: { sessionId?: string | null; baselineAssistantCount?: number; perDownloadTimeoutMs?: number } = {},
): Promise<{ ok: boolean; files: WebAiArtifactDescriptor[]; warnings: string[] }> {
    const { sessionId = null, baselineAssistantCount = 0, perDownloadTimeoutMs = DEFAULT_PER_DOWNLOAD_TIMEOUT_MS } = opts;
    const candidates = await readAssistantDownloadableFiles(cdpSession, { baselineAssistantCount });
    if (!candidates.length) return { ok: true, files: [], warnings: [] };
    if (!sessionId) return { ok: true, files: [], warnings: ['file-artifact-no-session'] };

    const cookieHeader = await getChatGptCookieHeader(cdpSession);
    const files: WebAiArtifactDescriptor[] = [];
    const warnings: string[] = [];
    let attributionStopped = false;

    for (let i = 0; i < candidates.length; i += 1) {
        const c = candidates[i];
        if (!c) continue;
        if (attributionStopped) {
            warnings.push(`file-artifact-skipped-after-timeout:${c.sourceUrl}`);
            continue;
        }
        const got = await fetchDownload(c.sourceUrl, cookieHeader, perDownloadTimeoutMs);
        if ('timedOut' in got) {
            attributionStopped = true;
            warnings.push(`file-artifact-timeout:${c.sourceUrl}`);
            continue;
        }
        if ('failed' in got) {
            warnings.push(`file-artifact-fetch-failed:${c.sourceUrl}`);
            continue;
        }
        const filename = resolveDownloadFilename({
            contentDisposition: got.contentDisposition,
            downloadAttr: c.download,
            sourceUrl: c.sourceUrl,
            index: i,
        });
        const res = trySaveFileArtifact(sessionId, {
            filename,
            buffer: got.buffer,
            mimeType: got.mimeType,
            sourceUrl: c.sourceUrl,
        });
        if (!res.ok) {
            warnings.push(`file-artifact-save-failed:${res.stage}`);
            continue;
        }
        appendSessionArtifact(sessionId, res.descriptor);
        files.push(res.descriptor);
    }
    return { ok: true, files, warnings };
}
