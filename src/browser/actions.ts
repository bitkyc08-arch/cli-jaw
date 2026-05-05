import { getActivePage, getCdpSession, getBrowserStateVersion, markBrowserStateChanged, getActiveTab } from './connection.js';
import { JAW_HOME } from '../core/config.js';
import { join } from 'path';
import fs from 'fs';
import type { ConsoleMessage, Locator, Page, Request } from 'playwright-core';

const SCREENSHOTS_DIR = join(JAW_HOME, 'screenshots');
const DEFAULT_DOM_MAX_CHARS = 20000;
const TOKEN_PATTERNS = [
    /authorization\s*[:=]\s*[^,\s]+/ig,
    /cookie\s*[:=]\s*[^,\s]+/ig,
    /access_token=[^&\s]+/ig,
    /token=[^&\s]+/ig,
];

type SnapshotNode = {
    ref: string;
    role: string;
    name: string;
    depth: number;
    value?: string;
    occurrence: number;
};

type SnapshotState = {
    snapshotId: string;
    stateVersion: number;
    targetId: string | null;
    url: string;
    nodes: SnapshotNode[];
};

type ClipRect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type BrowserActionOptions = Record<string, unknown>;
type MouseButton = 'left' | 'right' | 'middle';
type ScreenshotImageType = 'png' | 'jpeg';
type WaitForSelectorState = 'attached' | 'detached' | 'visible' | 'hidden';
type AriaRole = Parameters<Page['getByRole']>[0];
type JsonRecord = Record<string, unknown>;
type CdpAxValue = { value?: unknown };
type CdpAxNode = {
    nodeId?: unknown;
    parentId?: unknown;
    role?: CdpAxValue;
    name?: CdpAxValue;
    value?: CdpAxValue;
    ignored?: unknown;
};
let latestSnapshot: SnapshotState | null = null;
const consoleEntries: Array<{ type: string; text: string; ts: number }> = [];
const networkEntries: Array<{ method: string; url: string; type?: string; source: 'cdp'; ts: number }> = [];
let captureInstalled = false;

// ─── ref snapshot ────────────────────────────────

const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'checkbox',
    'radio', 'combobox', 'menuitem', 'tab', 'slider', 'searchbox',
    'option', 'switch', 'spinbutton'];

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fieldString(record: JsonRecord, key: string): string {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}

function optionString(opts: BrowserActionOptions, key: string, fallback = ''): string {
    const value = opts[key];
    return typeof value === 'string' ? value : fallback;
}

function optionBoolean(opts: BrowserActionOptions, key: string): boolean {
    return opts[key] === true;
}

function optionNumber(opts: BrowserActionOptions, key: string, fallback: number): number {
    const value = opts[key];
    const parsed = typeof value === 'number' ? value : Number(value ?? fallback);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function optionMouseButton(opts: BrowserActionOptions): MouseButton {
    const value = opts.button;
    return value === 'right' || value === 'middle' ? value : 'left';
}

function optionWaitState(opts: BrowserActionOptions): WaitForSelectorState {
    const value = opts.state;
    if (value === 'attached' || value === 'detached' || value === 'hidden' || value === 'visible') return value;
    return 'visible';
}

function optionScreenshotType(opts: BrowserActionOptions): ScreenshotImageType {
    return opts.type === 'jpeg' ? 'jpeg' : 'png';
}

async function requireActivePage(port: number): Promise<Page> {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    return page;
}

function extractCdpAxNodes(value: unknown): unknown[] {
    return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
}

function normalizeActiveTargetId(activeTab: Awaited<ReturnType<typeof getActiveTab>>): string | null {
    return activeTab.ok ? activeTab.tab?.targetId || null : null;
}

function asCdpAxNode(value: unknown): CdpAxNode | null {
    return isRecord(value) ? value : null;
}

function cdpValueText(value: unknown): string {
    return isRecord(value) && typeof value.value === 'string' ? value.value : '';
}

/**
 * Parse Playwright ariaSnapshot YAML into flat node list.
 * Format: "- role \"name\":" or "- role \"name\""
 */
function parseAriaYaml(yaml: string): SnapshotNode[] {
    const nodes: Omit<SnapshotNode, 'occurrence'>[] = [];
    let counter = 0;
    for (const line of yaml.split('\n')) {
        if (!line.trim() || !line.includes('-')) continue;
        const indent = line.search(/\S/);
        const depth = Math.floor(indent / 2);
        // Match: - role "name" or - role "name": or - text: content
        const m = line.match(/-\s+(\w+)(?:\s+"([^"]*)")?/);
        if (!m) continue;
        counter++;
        const role = m[1] || 'unknown';
        const name = m[2] || '';
        nodes.push({ ref: `e${counter}`, role, name, depth });
    }
    return annotateOccurrences(nodes);
}

/**
 * Parse CDP Accessibility.getFullAXTree response into flat node list.
 */
function parseCdpAxTree(axNodes: unknown[]): SnapshotNode[] {
    const nodes: Omit<SnapshotNode, 'occurrence'>[] = [];
    let counter = 0;
    // CDP returns flat list with parentId references; build depth map
    const depthMap: Record<string, number> = {};
    for (const value of axNodes) {
        const n = asCdpAxNode(value);
        if (!n) continue;
        const nodeId = typeof n.nodeId === 'string' ? n.nodeId : '';
        const parentId = typeof n.parentId === 'string' ? n.parentId : '';
        const parentDepth = parentId ? (depthMap[parentId] ?? 0) : -1;
        const depth = parentDepth + 1;
        if (nodeId) depthMap[nodeId] = depth;
        const role = cdpValueText(n.role) || 'unknown';
        const name = cdpValueText(n.name);
        const nodeValue = cdpValueText(n.value);
        if (n.ignored) continue;
        counter++;
        nodes.push({
            ref: `e${counter}`, role, name,
            ...(nodeValue ? { value: nodeValue } : {}),
            depth,
        });
    }
    return annotateOccurrences(nodes);
}

export async function snapshot(port: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);

    let nodes;

    // Strategy 1: locator.ariaSnapshot() — works on CDP connections (v1.49+)
    try {
        const yaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
        nodes = parseAriaYaml(yaml);
    } catch (e1) {
        // Strategy 2: direct CDP Accessibility.getFullAXTree
        try {
            const cdp = await getCdpSession(port);
            if (!cdp) throw new Error('No CDP session available for snapshot fallback');
            const axNodes = extractCdpAxNodes(await cdp.send('Accessibility.getFullAXTree'));
            nodes = parseCdpAxTree(axNodes);
            await cdp.detach().catch(() => { });
        } catch (e2) {
            throw new Error(
                `Snapshot failed.\n  ariaSnapshot: ${(e1 as Error).message}\n  CDP fallback: ${(e2 as Error).message}`
            );
        }
    }

    if (opts.interactive) {
        nodes = nodes.filter(n => INTERACTIVE_ROLES.includes(n.role));
    }

    const total = nodes.length;
    const maxNodes = optionNumber(opts, 'maxNodes', optionNumber(opts, 'max-nodes', 0));
    if (Number.isInteger(maxNodes) && maxNodes > 0) nodes = nodes.slice(0, maxNodes);
    const activeTab = await getActiveTab(port).catch(() => ({ ok: false as const }));
    latestSnapshot = {
        snapshotId: `snap_${Date.now()}`,
        stateVersion: getBrowserStateVersion(),
        targetId: normalizeActiveTargetId(activeTab),
        url: page.url(),
        nodes,
    };
    if (opts.json) return { nodes, meta: { total, shown: nodes.length, snapshotId: latestSnapshot.snapshotId } };
    return nodes;
}

function annotateOccurrences(nodes: Omit<SnapshotNode, 'occurrence'>[]): SnapshotNode[] {
    const counts = new Map<string, number>();
    return nodes.map((node) => {
        const key = `${node.role}\u0000${node.name}`;
        const occurrence = counts.get(key) || 0;
        counts.set(key, occurrence + 1);
        return { ...node, occurrence };
    });
}

// ─── ref → locator ─────────────────────────────

async function refToLocator(page: Page, port: number, ref: string): Promise<Locator> {
    let nodes: SnapshotNode[];
    const activeTab = await getActiveTab(port).catch(() => ({ ok: false as const }));
    const activeTargetId = normalizeActiveTargetId(activeTab);
    if (
        latestSnapshot
        && latestSnapshot.targetId
        && activeTargetId === latestSnapshot.targetId
        && latestSnapshot.stateVersion === getBrowserStateVersion()
        && latestSnapshot.url === page.url()
    ) {
        nodes = latestSnapshot.nodes;
    } else {
        const fresh = await snapshot(port) as SnapshotNode[];
        nodes = fresh;
    }
    const node = nodes.find(n => n.ref === ref);
    if (!node) throw new Error(`ref ${ref} not found — re-run snapshot`);
    return page.getByRole(node.role as AriaRole, { name: node.name }).nth(node.occurrence || 0);
}

// ─── screenshot ────────────────────────────────

export async function screenshot(port: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    const type = optionScreenshotType(opts);
    const filename = `screenshot_${Date.now()}.${type}`;
    const filepath = join(SCREENSHOTS_DIR, filename);

    const clip = normalizeClip(opts.clip);
    if (opts.ref && clip) throw new Error('screenshot cannot combine ref and clip');
    if (opts.ref) {
        const locator = await refToLocator(page, port, String(opts.ref));
        await locator.screenshot({ path: filepath, type });
    } else {
        await page.screenshot({ path: filepath, fullPage: optionBoolean(opts, 'fullPage'), type, ...(clip ? { clip } : {}) });
    }
    const dpr = await page.evaluate('window.devicePixelRatio');
    const viewport = page.viewportSize();
    return { path: filepath, dpr, viewport, ...(clip ? { clip } : {}) };
}

function normalizeClip(value: unknown): ClipRect | undefined {
    if (!value) return undefined;
    const clip = Array.isArray(value)
        ? { x: Number(value[0]), y: Number(value[1]), width: Number(value[2]), height: Number(value[3]) }
        : isRecord(value)
            ? { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) }
            : { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN };
    if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) throw new Error('invalid clip');
    if (clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0) throw new Error('invalid clip');
    return clip;
}

// ─── actions ───────────────────────────────────

export async function click(port: number, ref: string, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    const locator = await refToLocator(page, port, ref);
    if (optionBoolean(opts, 'doubleClick')) await locator.dblclick();
    else await locator.click({ button: optionMouseButton(opts) });
    return { ok: true, url: page.url() };
}

export async function type(port: number, ref: string, text: string, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.fill(text);
    if (optionBoolean(opts, 'submit')) await page.keyboard.press('Enter');
    return { ok: true };
}

export async function press(port: number, key: string) {
    const page = await requireActivePage(port);
    await page.keyboard.press(key);
    return { ok: true };
}

export async function hover(port: number, ref: string) {
    const page = await requireActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.hover();
    return { ok: true };
}

export async function navigate(port: number, url: string) {
    const page = await requireActivePage(port);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    markBrowserStateChanged();
    return { ok: true, url: page.url() };
}

export async function evaluate(port: number, expression: string) {
    const page = await requireActivePage(port);
    const result = await page.evaluate(expression);
    return { ok: true, result };
}

export async function getPageText(port: number, format = 'text') {
    const page = await requireActivePage(port);
    if (format === 'html') return { text: await page.content() };
    return { text: await page.innerText('body') };
}

export async function getDom(port: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    const selector = String(opts.selector || 'body');
    if (!selector.trim() || selector.includes('\0')) throw new Error('invalid selector');
    const maxChars = Math.max(1, optionNumber(opts, 'maxChars', optionNumber(opts, 'max-chars', DEFAULT_DOM_MAX_CHARS)));
    const locator = page.locator(selector).first();
    const html = selector === 'body' ? await page.content() : await locator.evaluate((el: { outerHTML: string }) => el.outerHTML);
    const truncated = html.length > maxChars;
    return { html: truncated ? html.slice(0, maxChars) : html, selector, truncated, chars: Math.min(html.length, maxChars), totalChars: html.length };
}

export async function waitForSelector(port: number, selector: string, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    await page.waitForSelector(selector, {
        timeout: optionNumber(opts, 'timeout', 30000),
        state: optionWaitState(opts),
    });
    return { ok: true };
}

export async function waitForText(port: number, text: string, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    await page.getByText(text).first().waitFor({ timeout: optionNumber(opts, 'timeout', 30000), state: 'visible' });
    return { ok: true };
}

export async function reload(port: number) {
    const page = await requireActivePage(port);
    await page.reload({ waitUntil: 'domcontentloaded' });
    markBrowserStateChanged();
    return { ok: true, url: page.url() };
}

export async function resize(port: number, width: number, height: number) {
    const page = await requireActivePage(port);
    await page.setViewportSize({ width, height });
    markBrowserStateChanged();
    return { ok: true, viewport: page.viewportSize() };
}

export async function scroll(port: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    const x = optionNumber(opts, 'x', 0);
    const y = optionNumber(opts, 'y', 0);
    if (opts.ref) {
        const locator = await refToLocator(page, port, String(opts.ref));
        await locator.evaluate((el: { scrollBy(x: number, y: number): void }, delta: { x: number; y: number }) => el.scrollBy(delta.x, delta.y), { x, y });
    } else {
        await page.mouse.wheel(x, y);
    }
    return { ok: true };
}

export async function select(port: number, ref: string, values: string[]) {
    const page = await requireActivePage(port);
    const locator = await refToLocator(page, port, ref);
    const selected = await locator.selectOption(values);
    return { ok: true, selected };
}

export async function drag(port: number, fromRef: string, toRef: string) {
    const page = await requireActivePage(port);
    const from = await refToLocator(page, port, fromRef);
    const to = await refToLocator(page, port, toRef);
    await from.dragTo(to);
    return { ok: true };
}

export async function mouseMove(port: number, x: number, y: number) {
    const page = await requireActivePage(port);
    await page.mouse.move(x, y);
    return { ok: true };
}

export async function mouseDown(port: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    await page.mouse.down({ button: optionMouseButton(opts) });
    return { ok: true };
}

export async function mouseUp(port: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    await page.mouse.up({ button: optionMouseButton(opts) });
    return { ok: true };
}

function redactText(input: string, maxTextLength = 2000) {
    let text = input.slice(0, maxTextLength);
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[redacted]');
    return text;
}

async function ensureCaptureInstalled(port: number) {
    if (captureInstalled) return;
    const page = await requireActivePage(port);
    page.on('console', (msg: ConsoleMessage) => {
        consoleEntries.push({ type: msg.type(), text: redactText(msg.text()), ts: Date.now() });
        if (consoleEntries.length > 500) consoleEntries.shift();
    });
    page.on('request', (req: Request) => {
        const parsed = new URL(req.url());
        networkEntries.push({
            method: req.method(),
            url: `${parsed.origin}${parsed.pathname}`,
            type: req.resourceType?.(),
            source: 'cdp',
            ts: Date.now(),
        });
        if (networkEntries.length > 500) networkEntries.shift();
    });
    captureInstalled = true;
}

export async function getConsole(port: number, opts: BrowserActionOptions = {}) {
    await ensureCaptureInstalled(port);
    if (opts.clear) consoleEntries.length = 0;
    const limit = Math.max(1, optionNumber(opts, 'limit', 50));
    const maxTextLength = Math.max(1, optionNumber(opts, 'maxTextLength', 2000));
    return { entries: consoleEntries.slice(-limit).map(e => ({ ...e, text: redactText(e.text, maxTextLength) })) };
}

export async function getNetwork(port: number, opts: BrowserActionOptions = {}) {
    await ensureCaptureInstalled(port);
    const limit = Math.max(1, optionNumber(opts, 'limit', 50));
    const filter = opts.filter ? String(opts.filter) : '';
    const entries = networkEntries
        .filter(e => !filter || e.url.includes(filter))
        .slice(-limit)
        .map(e => {
            const parsed = new URL(e.url);
            return { method: e.method, origin: parsed.origin, path: parsed.pathname, type: e.type, source: e.source, redacted: true };
        });
    return { entries };
}

/** Click at pixel coordinates (vision-click support) */
export async function mouseClick(port: number, x: number, y: number, opts: BrowserActionOptions = {}) {
    const page = await requireActivePage(port);
    if (optionBoolean(opts, 'doubleClick')) await page.mouse.dblclick(x, y);
    else await page.mouse.click(x, y, { button: optionMouseButton(opts) });
    return { success: true, clicked: { x, y } };
}
