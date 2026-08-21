import { basename, resolve } from 'node:path';
import type { Page, Locator } from 'playwright-core';

// Parity catalog 102 (chatgpt-upload-surface, "BEHIND"). Strict-TS port of agbrowse
// web-ai/chatgpt-upload-surface.mjs. cli-jaw chatgpt-attachments had inline selectors
// but not the scored candidate/probe split: scoreFileInputCandidate ranks file inputs
// (in-composer / visible / multiple / image-accept), findFirstFileInput picks the best,
// and setFilesViaUploadSurface opens the upload button → menu item → file chooser.
// scoreFileInputCandidate / isImageAttachmentPath are pure/testable.

export interface AttachmentProbeFile {
    path: string;
    basename: string;
}

export interface AttachmentTarget {
    selector?: string;
}

export type UploadSurfaceResult =
    | { ok: true; method: string; selector?: string }
    | { ok: false; error: string };

export const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic']);

export const UPLOAD_BUTTON_SELECTORS = [
    '[data-testid="composer-plus-btn"]',
    'button[aria-label="Add files and more"]',
    'button[aria-label="파일 추가 및 기타"]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Attach" i]',
    'button[aria-label*="Add" i]',
    'button[data-testid*="plus" i]',
    'button:has-text("Upload")',
];

const FILE_INPUT_SELECTORS = [
    'main input[type="file"]',
    'form input[type="file"]',
    'input[type="file"][multiple]',
    'input[type="file"]',
];

const UPLOAD_MENU_ITEM_LABELS = [
    'Add photos & files',
    'Add photos and files',
    'Upload from computer',
    '사진 및 파일 추가',
    '사진과 파일 추가',
    '파일 추가',
];

const UPLOAD_MENU_ITEM_EXCLUDED_LABELS = [
    'Add files and more',
    '파일 추가 및 기타',
];

const MENU_CANDIDATE_SELECTOR = [
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    'button',
    'a',
    'div[role="button"]',
].join(', ');

export function isImageAttachmentPath(filePath: string): boolean {
    return IMAGE_ATTACHMENT_EXTENSIONS.has(extractExtension(basename(filePath)));
}

export interface FileInputMetadata {
    selector?: string;
    accept?: string | null;
    multiple?: boolean;
    visible?: boolean;
    inComposer?: boolean;
}

/**
 * Score a file-input candidate. Image-only inputs are disqualified for non-image
 * attachments; otherwise reward in-composer / visible / multiple inputs, and an
 * image-only input when the attachment is itself an image.
 */
export function scoreFileInputCandidate(
    inputMetadata: FileInputMetadata = {},
    options: { isImageAttachment?: boolean } = {},
): number {
    const accept = String(inputMetadata.accept || '').toLowerCase();
    const acceptsOnlyImages = Boolean(accept) && accept.split(',').every((part) => part.trim().startsWith('image/'));
    if (acceptsOnlyImages && options.isImageAttachment !== true) return Number.NEGATIVE_INFINITY;
    let score = 0;
    if (inputMetadata.inComposer) score += 20;
    if (inputMetadata.visible) score += 10;
    if (inputMetadata.multiple) score += 5;
    if (acceptsOnlyImages && options.isImageAttachment === true) score += 3;
    return score;
}

export async function findFirstFileInput(page: Page, file: AttachmentProbeFile): Promise<string | null> {
    let best: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const sel of FILE_INPUT_SELECTORS) {
        const loc = page.locator(sel).first();
        if ((await page.locator(sel).count().catch(() => 0)) === 0) continue;
        const accept = await loc.getAttribute('accept').catch(() => null);
        const multipleAttr = await loc.getAttribute('multiple').catch(() => null);
        const visible = await loc.isVisible().catch(() => false);
        const score = scoreFileInputCandidate({
            selector: sel,
            accept,
            multiple: multipleAttr !== null || sel.includes('multiple'),
            visible,
            inComposer: sel.startsWith('main') || sel.startsWith('form'),
        }, { isImageAttachment: isImageAttachmentPath(file?.basename || file?.path || '') });
        if (score > bestScore) {
            best = sel;
            bestScore = score;
        }
    }
    return bestScore === Number.NEGATIVE_INFINITY ? null : best;
}

export async function setFilesViaUploadSurface(
    page: Page,
    filePaths: string | string[],
    probeFile: AttachmentProbeFile,
    usedFallbacks: string[],
    uploadTarget: AttachmentTarget | null = null,
): Promise<UploadSurfaceResult> {
    const selectors = uploadTarget?.selector ? [uploadTarget.selector] : UPLOAD_BUTTON_SELECTORS;
    let lastError = 'upload surface did not expose a file input or chooser';
    for (const selector of selectors) {
        const clicked = await clickUploadButton(page, selector, usedFallbacks);
        if (!clicked) continue;
        await page.waitForTimeout(300).catch(() => undefined);

        const directInput = await setFilesOnDiscoveredInput(page, filePaths, probeFile, selector);
        if (directInput.ok === true) return directInput;
        lastError = directInput.error;

        const menuItem = await findVisibleUploadMenuItem(page);
        if (menuItem) {
            const menuResult = await clickUploadMenuItemAndSetFiles(page, menuItem, filePaths, probeFile);
            if (menuResult.ok === true) return menuResult;
            lastError = menuResult.error;
        }

        usedFallbacks.push(`upload-surface-no-file-input:${selector}`);
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(100).catch(() => undefined);
    }
    return { ok: false, error: lastError };
}

async function setFilesOnDiscoveredInput(
    page: Page,
    filePaths: string | string[],
    probeFile: AttachmentProbeFile,
    openerSelector: string,
): Promise<UploadSurfaceResult> {
    const inputSel = await findFirstFileInput(page, probeFile);
    if (!inputSel) return { ok: false, error: 'composer file input not found' };
    try {
        await page.locator(inputSel).first().setInputFiles(filePaths, { timeout: 15_000 });
        return { ok: true, method: 'input', selector: inputSel };
    } catch (e) {
        return { ok: false, error: `setInputFiles after ${openerSelector} failed: ${(e as { message?: string })?.message}` };
    }
}

async function clickUploadMenuItemAndSetFiles(
    page: Page,
    menuItem: Locator,
    filePaths: string | string[],
    probeFile: AttachmentProbeFile,
): Promise<UploadSurfaceResult> {
    const chooserPromise = waitForFileChooser(page);
    const clicked = await menuItem.click({ timeout: 3_000 })
        .then(() => true)
        .catch(async () => {
            const box = await menuItem.boundingBox().catch(() => null);
            if (!box) return false;
            return page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
                .then(() => true)
                .catch(() => false);
        });
    if (!clicked) return { ok: false, error: 'upload menu item click failed' };

    const chooser = await chooserPromise;
    if (chooser) {
        try {
            await chooser.setFiles(filePaths, { timeout: 15_000 });
            return { ok: true, method: 'filechooser' };
        } catch (e) {
            return { ok: false, error: `filechooser.setFiles failed: ${(e as { message?: string })?.message}` };
        }
    }

    await page.waitForTimeout(300).catch(() => undefined);
    return setFilesOnDiscoveredInput(page, filePaths, probeFile, 'upload-menu-item');
}

interface FileChooserLike {
    setFiles(files: string | string[], options?: { timeout?: number }): Promise<void>;
}

async function waitForFileChooser(page: Page): Promise<FileChooserLike | null> {
    if (typeof page.waitForEvent !== 'function') return null;
    return page.waitForEvent('filechooser', { timeout: 750 }).catch(() => null);
}

async function findVisibleUploadMenuItem(page: Page): Promise<Locator | null> {
    const candidates = await page.locator(MENU_CANDIDATE_SELECTOR).all().catch((): Locator[] => []);
    for (const candidate of candidates) {
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const text = normalizeUiText(await candidate.innerText({ timeout: 500 }).catch(() => ''));
        if (!text) continue;
        if (UPLOAD_MENU_ITEM_EXCLUDED_LABELS.some((label) => textIncludesLabel(text, label))) continue;
        if (UPLOAD_MENU_ITEM_LABELS.some((label) => textIncludesLabel(text, label))) return candidate;
    }
    return null;
}

async function clickUploadButton(page: Page, selector: string, usedFallbacks: string[]): Promise<boolean> {
    const loc = page.locator(selector).first();
    const visible = await loc.isVisible().catch(() => false);
    const enabled = await loc.isEnabled().catch(() => false);
    if (!visible || !enabled) return false;
    try {
        await loc.click({ timeout: 3_000 });
        return true;
    } catch (e) {
        usedFallbacks.push(`upload-button-click-failed:${selector}:${(e as { message?: string })?.message}`);
        return false;
    }
}

function normalizeUiText(text: unknown): string {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function textIncludesLabel(haystack: string, label: string): boolean {
    const normalized = normalizeUiText(label);
    return Boolean(normalized) && haystack.includes(normalized);
}

function extractExtension(name: string): string {
    const idx = name.lastIndexOf('.');
    return idx < 0 ? '' : name.slice(idx).toLowerCase();
}

// ── Size-aware upload budgets + CDP 50MB-safe injection (parity2 060, C-11/A-05) ──

export const DEFAULT_ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;
/**
 * Playwright treats connectOverCDP browsers as remote and streams file bytes
 * over the driver websocket with a hard ~50MB per-file limit
 * (microsoft/playwright#34192). cli-jaw drives a LOCAL Chrome, so raw CDP
 * `DOM.setFileInputFiles` with local absolute paths transfers zero bytes and
 * has no size limit. Above this threshold we inject via CDP first.
 */
export const CDP_INJECTION_THRESHOLD_BYTES = 45 * 1024 * 1024;
const PLAYWRIGHT_TRANSFER_LIMIT_PATTERN = /50 ?mb|larger than/i;
const ACCEPTANCE_BYTES_PER_SECOND = 250 * 1024;
const HANDOFF_BYTES_PER_SECOND = 5 * 1024 * 1024;
const SEND_READY_BYTES_PER_SECOND = 1024 * 1024;
const ACCEPTANCE_CEILING_MS = 900_000;
const HANDOFF_CEILING_MS = 300_000;
const SEND_READY_CEILING_MS = 300_000;

function clampMs(value: number, min: number, max: number): number {
    return Math.floor(Math.min(Math.max(value, min), max));
}

/**
 * Size-aware timeout budgets for one attachment batch. Explicit
 * `attachmentUploadTimeoutMs` (option or JAW_ATTACHMENT_UPLOAD_TIMEOUT_MS env)
 * wins for the browser handoff; acceptance and send-readiness scale with total
 * bytes so a 100MB upload is not judged by a fixed 45/60s window.
 */
export function computeAttachmentTimeouts(
    files: Array<{ sizeBytes?: number }> = [],
    options: { attachmentUploadTimeoutMs?: number | string | null } = {},
): { totalBytes: number; handoffMs: number; acceptanceMs: number; sendReadyMs: number } {
    const list = Array.isArray(files) ? files : [];
    const totalBytes = list.reduce((sum, file) => sum + (Number(file?.sizeBytes) || 0), 0);
    const explicit = options.attachmentUploadTimeoutMs ?? process.env['JAW_ATTACHMENT_UPLOAD_TIMEOUT_MS'] ?? process.env['AGBROWSE_ATTACHMENT_UPLOAD_TIMEOUT_MS'];
    const explicitMs = (explicit === undefined || explicit === null || explicit === '') ? NaN : Number(explicit);
    const handoffMs = Number.isFinite(explicitMs) && explicitMs > 0
        ? Math.round(explicitMs)
        : clampMs(
            DEFAULT_ATTACHMENT_UPLOAD_TIMEOUT_MS + (totalBytes / HANDOFF_BYTES_PER_SECOND) * 1000,
            DEFAULT_ATTACHMENT_UPLOAD_TIMEOUT_MS,
            HANDOFF_CEILING_MS,
        );
    const acceptanceBaseMs = list.length > 1 ? 60_000 : 45_000;
    let acceptanceMs = clampMs(
        acceptanceBaseMs + (totalBytes / ACCEPTANCE_BYTES_PER_SECOND) * 1000,
        acceptanceBaseMs,
        ACCEPTANCE_CEILING_MS,
    );
    const acceptanceFloorMs = Number(process.env['JAW_ATTACHMENT_ACCEPT_TIMEOUT_MS']);
    if (Number.isFinite(acceptanceFloorMs) && acceptanceFloorMs > 0) {
        acceptanceMs = Math.max(acceptanceMs, Math.round(acceptanceFloorMs));
    }
    const sendReadyMs = list.length === 0
        ? 20_000
        : clampMs(45_000 + (totalBytes / SEND_READY_BYTES_PER_SECOND) * 1000, 45_000, SEND_READY_CEILING_MS);
    return { totalBytes, handoffMs, acceptanceMs, sendReadyMs };
}

/**
 * Inject local file paths into a file input through raw CDP
 * `DOM.setFileInputFiles`. Zero-byte transfer, no Playwright 50MB limit.
 * Degrades to `{ ok: false }` on fake/unit-test pages without a CDP session.
 */
export async function setInputFilesViaCdp(page: Page, inputSel: string, filePaths: string | string[]): Promise<{ ok: true } | { ok: false; error: string }> {
    const anyPage = page as unknown as { context?: () => { newCDPSession?: (p: unknown) => Promise<{ send: (m: string, p?: Record<string, unknown>) => Promise<unknown>; detach?: () => Promise<void> }> } };
    const context = typeof anyPage?.context === 'function' ? anyPage.context() : null;
    if (!context || typeof context.newCDPSession !== 'function') {
        return { ok: false, error: 'cdp session unavailable on this page' };
    }
    let session: { detach?: () => Promise<void> } | null = null;
    try {
        const cdp = await context.newCDPSession(page);
        session = cdp;
        const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).map(p => resolve(String(p)));
        const doc = await cdp.send('DOM.getDocument') as { root?: { nodeId?: number } };
        const rootNodeId = doc?.root?.nodeId;
        if (!rootNodeId) return { ok: false, error: 'cdp DOM.getDocument returned no root node' };
        const node = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: inputSel }) as { nodeId?: number };
        if (!node?.nodeId) return { ok: false, error: `cdp querySelector found no node for ${inputSel}` };
        await cdp.send('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: `cdp setFileInputFiles failed: ${(e as { message?: string })?.message || e}` };
    } finally {
        await session?.detach?.().catch(() => undefined);
    }
}

/**
 * Set files on a discovered input with the 50MB-safe strategy: CDP-first for
 * large batches, Playwright setInputFiles otherwise, each falling back to the
 * other. Records the effective method in `usedFallbacks`.
 */
export async function setInputFilesResilient(
    page: Page,
    inputSel: string,
    filePaths: string | string[],
    { timeoutMs = 8_000, totalBytes = 0, usedFallbacks = [] }: { timeoutMs?: number; totalBytes?: number; usedFallbacks?: string[] } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const preferCdp = Number(totalBytes) >= CDP_INJECTION_THRESHOLD_BYTES;
    if (preferCdp) {
        const viaCdp = await setInputFilesViaCdp(page, inputSel, paths);
        if (viaCdp.ok) {
            usedFallbacks.push('cdp-set-input-files');
            return { ok: true };
        }
        usedFallbacks.push(`cdp-set-input-files-failed:${viaCdp.error}`);
    }
    try {
        await page.locator(inputSel).first().setInputFiles(paths, { timeout: timeoutMs });
        return { ok: true };
    } catch (e) {
        const message = String((e as Error)?.message || e);
        if (!preferCdp && PLAYWRIGHT_TRANSFER_LIMIT_PATTERN.test(message)) {
            const viaCdp = await setInputFilesViaCdp(page, inputSel, paths);
            if (viaCdp.ok) {
                usedFallbacks.push('cdp-set-input-files-after-limit');
                return { ok: true };
            }
            usedFallbacks.push(`cdp-set-input-files-failed:${viaCdp.error}`);
        }
        return { ok: false, error: `setInputFiles failed: ${message}` };
    }
}

