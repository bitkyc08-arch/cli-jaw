import { createHash } from 'node:crypto';
import { WebAiError } from './errors.js';

export interface AnnotatedScreenshotOptions {
    provider?: string | null;
    highlightRefs?: string[];
    highlightColor?: string;
    padding?: number;
    maxDimension?: number;
    quality?: number;
}

export interface AnnotatedScreenshotResult {
    screenshotId: string;
    provider: string | null;
    url: string | null;
    imageHash: string;
    format: 'png';
    width: number;
    height: number;
    highlightCount: number;
    timestamp: string;
}

export interface AnnotatedScreenshotPageLike {
    url?: () => string | null;
    screenshot: (options?: { type?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; maxDimension?: number }) => Promise<Buffer>;
    evaluate: <T, A>(fn: (arg: A) => T, arg: A) => Promise<T>;
    locator: (selector: string) => {
        boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
    };
}

export async function buildAnnotatedScreenshot(
    page: AnnotatedScreenshotPageLike,
    {
        provider = null,
        highlightRefs = [],
        highlightColor = 'rgba(255, 0, 0, 0.3)',
        padding = 4,
        maxDimension = 2048,
        quality = 90,
    }: AnnotatedScreenshotOptions = {},
): Promise<AnnotatedScreenshotResult> {
    if (!page?.screenshot || typeof page.screenshot !== 'function') {
        throw new WebAiError({
            errorCode: 'screenshot.unavailable',
            stage: 'visual-fallback',
            retryHint: 'pin-playwright-or-add-cdp-fallback',
            message: 'page.screenshot() is not available in this Playwright runtime',
        });
    }

    const boxes = await resolveHighlightBoxes(page, highlightRefs);
    const screenshot = await page.screenshot({
        type: 'png',
        quality,
        fullPage: false,
        maxDimension,
    }).catch((err: unknown) => {
        throw new WebAiError({
            errorCode: 'screenshot.capture-failed',
            stage: 'visual-fallback',
            retryHint: 'retry-or-skip-visual',
            message: (err as { message?: string })?.message || 'screenshot capture failed',
            evidence: { err },
        });
    });

    const annotated = boxes.length > 0
        ? await drawHighlightOverlay(screenshot, boxes, { highlightColor, padding })
        : screenshot;

    const imageHash = hashImageBytes(annotated);
    const dimensions = await readImageDimensions(annotated);

    return {
        screenshotId: `scr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        provider,
        url: page.url?.() || null,
        imageHash,
        format: 'png',
        width: dimensions.width,
        height: dimensions.height,
        highlightCount: boxes.length,
        timestamp: new Date().toISOString(),
    };
}

async function resolveHighlightBoxes(page: AnnotatedScreenshotPageLike, refs: string[]): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
    if (!refs.length) return [];
    return page.evaluate((refList: string[]) => {
        const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (const ref of refList) {
            const el = (globalThis as any).document.querySelector(`[data-web-ai-ref="${ref}"]`);
            if (!el) continue;
            const rect = (el as any).getBoundingClientRect();
            boxes.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        }
        return boxes;
    }, refs).catch(() => []);
}

async function drawHighlightOverlay(
    image: Buffer,
    boxes: Array<{ x: number; y: number; width: number; height: number }>,
    { highlightColor, padding }: { highlightColor: string; padding: number },
): Promise<Buffer> {
    void image;
    void boxes;
    void highlightColor;
    void padding;
    // TODO: integrate with sharp or canvas library for actual overlay drawing
    return image;
}

async function readImageDimensions(image: Buffer): Promise<{ width: number; height: number }> {
    void image;
    // TODO: integrate with sharp or image-size library
    return { width: 0, height: 0 };
}

function hashImageBytes(buffer: Buffer): string {
    return `sha256:${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}`;
}

export function summarizeScreenshotForDoctor(result: AnnotatedScreenshotResult | null | undefined): {
    enabled: boolean;
    screenshotId: string | null;
    imageHash: string | null;
    width: number;
    height: number;
    highlightCount: number;
} {
    return {
        enabled: true,
        screenshotId: result?.screenshotId || null,
        imageHash: result?.imageHash || null,
        width: result?.width || 0,
        height: result?.height || 0,
        highlightCount: result?.highlightCount || 0,
    };
}
