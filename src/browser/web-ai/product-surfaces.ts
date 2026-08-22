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
