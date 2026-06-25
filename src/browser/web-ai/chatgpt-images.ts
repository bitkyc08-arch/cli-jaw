import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { resolveArtifactsDir, saveImageArtifact } from './session-artifacts.js';
import { appendSessionArtifact } from './session.js';
import type { CdpSendSession } from './chatgpt-project-sources.js';

// Parity catalog 102 (generated images, P1). Strict-TS port of agbrowse
// web-ai/chatgpt-images.mjs. cli-jaw had image *tool-selection* but no output capture;
// this detects DALL·E/estuary generated images in assistant turns and downloads them
// (explicit --output paths or session artifacts). Pure detection-expression builder,
// URL allowlist, output-path derivation, and chrome-text classifier are fully testable.
// Artifact capture uses cli-jaw's saveImageArtifact → appendSessionArtifact (not agbrowse
// appendArtifactRecord).

const ESTUARY_PATTERN = /backend-api\/estuary\/content\?id=(file_[A-Za-z0-9_-]+)/;
const ALLOWED_HOST = 'chatgpt.com';
const DEFAULT_IMAGE_WAIT_TIMEOUT_MS = 60_000;
const CONVERSATION_TURN_SELECTOR = 'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"]';
const ASSISTANT_ROOT_SELECTOR = '[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant" i]';

export interface DetectedImage {
    url: string;
    fileId: string;
    alt: string;
    width: number;
    height: number;
}

export interface DownloadedImage {
    path: string;
    mimeType: string;
    sizeBytes: number;
    sourceUrl: string;
    fileId: string;
}

export function buildGeneratedImageDetectionExpression(baselineAssistantCount = 0): string {
    const minAssistantLiteral = Number.isFinite(Number(baselineAssistantCount))
        ? Math.max(0, Math.floor(Number(baselineAssistantCount)))
        : 0;
    return `(() => {
            const MIN_ASSISTANT_INDEX = ${minAssistantLiteral};
            const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
            const ASSISTANT_SELECTOR = ${JSON.stringify(ASSISTANT_ROOT_SELECTOR)};
            const isGeneratedImage = (img) => {
                const src = img?.currentSrc || img?.src || '';
                if (!src.includes('/backend-api/estuary/content?id=file_')) return false;
                const alt = String(img.alt || '').toLowerCase();
                if (alt.includes('generated image')) return true;
                let node = img;
                while (node instanceof HTMLElement) {
                    const id = String(node.id || '');
                    const className = String(node.className || '');
                    if (id.startsWith('image-')) return true;
                    if (className.includes('imagegen-image')) return true;
                    node = node.parentElement;
                }
                return Boolean(img.closest?.(ASSISTANT_SELECTOR));
            };
            const isAssistantTurn = (node) => {
                if (!(node instanceof HTMLElement)) return false;
                const turn = String(node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
                if (turn === 'assistant') return true;
                const role = String(node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
                if (role === 'assistant') return true;
                const testId = String(node.getAttribute('data-testid') || '').toLowerCase();
                if (testId.includes('assistant')) return true;
                return Boolean(node.querySelector(ASSISTANT_SELECTOR));
            };
            const sortByDocumentOrder = (nodes) => nodes.sort((a, b) => {
                if (a === b) return 0;
                return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
            });
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
            sortByDocumentOrder(roots);
            const relevant = roots.slice(MIN_ASSISTANT_INDEX);
            const imgs = [];
            for (const msg of relevant) {
                for (const img of msg.querySelectorAll('img')) {
                    if (!isGeneratedImage(img)) continue;
                    const src = img.currentSrc || img.src || '';
                    const match = src.match(/backend-api\\/estuary\\/content\\?id=(file_[A-Za-z0-9_-]+)/);
                    if (match) {
                        imgs.push({
                            url: src,
                            fileId: match[1],
                            alt: img.alt || '',
                            width: img.naturalWidth || 0,
                            height: img.naturalHeight || 0,
                        });
                    }
                }
            }
            if (!imgs.length) {
                const boundary = MIN_ASSISTANT_INDEX > 0 ? roots[MIN_ASSISTANT_INDEX - 1] : null;
                for (const img of document.querySelectorAll('img')) {
                    if (!isGeneratedImage(img)) continue;
                    if (boundary && !(boundary.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
                    const src = img.currentSrc || img.src || '';
                    const match = src.match(/backend-api\\/estuary\\/content\\?id=(file_[A-Za-z0-9_-]+)/);
                    if (!match) continue;
                    imgs.push({
                        url: src,
                        fileId: match[1],
                        alt: img.alt || '',
                        width: img.naturalWidth || 0,
                        height: img.naturalHeight || 0,
                    });
                }
            }
            const deduped = new Map();
            for (const img of imgs) {
                const existing = deduped.get(img.fileId);
                if (!existing || (img.width * img.height) > (existing.width * existing.height)) {
                    deduped.set(img.fileId, img);
                }
            }
            return Array.from(deduped.values());
        })()`;
}

/** Detect generated images in assistant messages after a baseline count. */
export async function detectGeneratedImages(
    cdpSession: CdpSendSession,
    { baselineAssistantCount = 0 }: { baselineAssistantCount?: number } = {},
): Promise<DetectedImage[]> {
    const res = (await cdpSession.send('Runtime.evaluate', {
        expression: buildGeneratedImageDetectionExpression(baselineAssistantCount),
        returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = res?.result?.value;
    if (!value) return [];
    try {
        const raw = Array.isArray(value) ? value : JSON.parse(String(value));
        if (!Array.isArray(raw)) return [];
        return raw
            .map((img: Record<string, unknown>) => ({
                url: String(img?.['url'] || ''),
                fileId: String(img?.['fileId'] || ''),
                alt: String(img?.['alt'] || ''),
                width: Number(img?.['width'] || 0),
                height: Number(img?.['height'] || 0),
            }))
            .filter((img) => img.url && img.fileId);
    } catch {
        return [];
    }
}

export function isAllowedChatGptImageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.hostname === ALLOWED_HOST && ESTUARY_PATTERN.test(parsed.pathname + parsed.search);
    } catch {
        return false;
    }
}

/** Derive sibling output paths: "out.png" → ["out.png", "out-2.png", "out-3.png"]. */
export function deriveGeneratedImageOutputPaths(outputPath: string, count: number): string[] {
    if (count <= 1) return [outputPath];
    const ext = extname(outputPath);
    const base = outputPath.slice(0, -ext.length || undefined);
    return Array.from({ length: count }, (_, i) =>
        i === 0 ? outputPath : `${base}-${i + 1}${ext}`,
    );
}

export function resolveGeneratedImageWaitTimeoutMs(waitTimeoutMs: unknown): number {
    const parsed = Number(waitTimeoutMs);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_WAIT_TIMEOUT_MS;
    return Math.max(5_000, parsed);
}

/**
 * ChatGPT image-only turns often expose only UI chrome text such as "Edit". Treat that
 * as metadata, not as the assistant answer.
 */
export function isImageOnlyGeneratedImageChromeText(text: unknown): boolean {
    const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return normalized === ''
        || normalized === 'edit'
        || normalized === 'creating image'
        || normalized === 'stopped thinking'
        || normalized === 'stopped thinking edit';
}

/** Download detected images using ChatGPT cookies (explicit paths or session artifacts). */
export async function downloadGeneratedImages(
    cdpSession: CdpSendSession,
    images: DetectedImage[],
    { outputPath, sessionId }: { outputPath?: string | null; sessionId?: string | null } = {},
): Promise<DownloadedImage[]> {
    if (!images.length) return [];

    const cookieRes = (await cdpSession.send('Network.getCookies', {
        urls: ['https://chatgpt.com/'],
    })) as { cookies?: Array<{ name: string; value: string }> };
    const cookieHeader = (cookieRes.cookies || [])
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

    const results: DownloadedImage[] = [];
    const outputPaths = outputPath ? deriveGeneratedImageOutputPaths(outputPath, images.length) : [];

    for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        if (!isAllowedChatGptImageUrl(img.url)) continue;

        try {
            const resp = await fetch(img.url, {
                headers: {
                    Cookie: cookieHeader,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                },
                redirect: 'follow',
            });

            if (!resp.ok) continue;

            const contentType = resp.headers.get('content-type') || 'image/png';
            const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
                : contentType.includes('webp') ? '.webp'
                : contentType.includes('gif') ? '.gif'
                : '.png';

            const buffer = Buffer.from(await resp.arrayBuffer());
            let savePath: string;

            const explicitPath = outputPaths[i];
            if (explicitPath) {
                const dir = dirname(explicitPath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                writeFileSync(explicitPath, buffer);
                savePath = explicitPath;
            } else if (sessionId) {
                const desc = saveImageArtifact(sessionId, {
                    filename: `image-${i + 1}${ext}`,
                    buffer,
                    mimeType: contentType,
                    sourceUrl: img.url,
                });
                appendSessionArtifact(sessionId, desc);
                savePath = join(resolveArtifactsDir(sessionId), desc.path);
            } else {
                continue;
            }

            results.push({
                path: savePath,
                mimeType: contentType,
                sizeBytes: buffer.length,
                sourceUrl: img.url,
                fileId: img.fileId,
            });
        } catch {
            continue;
        }
    }
    return results;
}

export interface CollectImagesResult {
    images: DetectedImage[];
    savedPaths: string[];
    markdownSuffix: string;
    warnings: string[];
    errors: string[];
    explicitOutputRequested: boolean;
}

/** Collect generated images from a ChatGPT response (detect → wait → download). */
export async function collectImages(
    cdpSession: CdpSendSession,
    {
        baselineAssistantCount = 0,
        outputPath = null,
        sessionId = null,
        waitTimeoutMs = DEFAULT_IMAGE_WAIT_TIMEOUT_MS,
    }: {
        baselineAssistantCount?: number;
        outputPath?: string | null;
        sessionId?: string | null;
        waitTimeoutMs?: number;
    } = {},
): Promise<CollectImagesResult> {
    const explicitOutputRequested = outputPath !== null && outputPath !== undefined;
    let images = await detectGeneratedImages(cdpSession, { baselineAssistantCount });

    if (!images.length && (outputPath || sessionId)) {
        const deadline = Date.now() + resolveGeneratedImageWaitTimeoutMs(waitTimeoutMs);
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            images = await detectGeneratedImages(cdpSession, { baselineAssistantCount });
            if (images.length) break;
        }
    }

    if (!images.length) {
        return {
            images: [],
            savedPaths: [],
            markdownSuffix: '',
            warnings: [],
            errors: explicitOutputRequested ? ['no generated image detected for explicit output path'] : [],
            explicitOutputRequested,
        };
    }

    const downloaded = await downloadGeneratedImages(cdpSession, images, { outputPath, sessionId });
    const savedPaths = downloaded.map((d) => d.path);
    const errors = explicitOutputRequested && savedPaths.length === 0
        ? ['generated images were detected but no image file could be saved']
        : [];
    const warnings = !explicitOutputRequested && images.length > 0 && savedPaths.length === 0
        ? ['generated images were detected but implicit artifact save failed or was unavailable']
        : [];
    const markdownSuffix = savedPaths.length
        ? '\n\n' + savedPaths.map((p, i) => `![Generated image ${i + 1}](${p})`).join('\n')
        : '';

    return { images, savedPaths, markdownSuffix, warnings, errors, explicitOutputRequested };
}
