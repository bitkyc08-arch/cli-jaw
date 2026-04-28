import { getActivePage, getCdpSession, getBrowserStateVersion, markBrowserStateChanged, getActiveTab } from './connection.js';
import { JAW_HOME } from '../core/config.js';
import { join } from 'path';
import fs from 'fs';

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
let latestSnapshot: SnapshotState | null = null;
const consoleEntries: Array<{ type: string; text: string; ts: number }> = [];
const networkEntries: Array<{ method: string; url: string; type?: string; source: 'cdp'; ts: number }> = [];
let captureInstalled = false;

// ─── ref snapshot ────────────────────────────────

const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'checkbox',
    'radio', 'combobox', 'menuitem', 'tab', 'slider', 'searchbox',
    'option', 'switch', 'spinbutton'];

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
function parseCdpAxTree(axNodes: any[]): SnapshotNode[] {
    const nodes: Omit<SnapshotNode, 'occurrence'>[] = [];
    let counter = 0;
    // CDP returns flat list with parentId references; build depth map
    const depthMap: Record<string, number> = {};
    for (const n of axNodes) {
        const parentDepth = n.parentId ? (depthMap[n.parentId] ?? 0) : -1;
        const depth = parentDepth + 1;
        depthMap[n.nodeId] = depth;
        const role = n.role?.value || 'unknown';
        const name = n.name?.value || '';
        const value = n.value?.value || '';
        if (n.ignored) continue;
        counter++;
        nodes.push({
            ref: `e${counter}`, role, name,
            ...(value ? { value } : {}),
            depth,
        });
    }
    return annotateOccurrences(nodes);
}

export async function snapshot(port: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');

    let nodes;

    // Strategy 1: locator.ariaSnapshot() — works on CDP connections (v1.49+)
    try {
        const yaml = await page.locator('body').ariaSnapshot({ timeout: 10000 });
        nodes = parseAriaYaml(yaml);
    } catch (e1) {
        // Strategy 2: direct CDP Accessibility.getFullAXTree
        try {
            const cdp = await getCdpSession(port);
            const { nodes: axNodes } = await cdp.send('Accessibility.getFullAXTree');
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
    const maxNodes = Number(opts.maxNodes || opts['max-nodes'] || 0);
    if (Number.isInteger(maxNodes) && maxNodes > 0) nodes = nodes.slice(0, maxNodes);
    const activeTab: any = await getActiveTab(port).catch(() => ({ ok: false }));
    latestSnapshot = {
        snapshotId: `snap_${Date.now()}`,
        stateVersion: getBrowserStateVersion(),
        targetId: activeTab.ok ? activeTab.tab?.targetId || null : null,
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

async function refToLocator(page: any, port: number, ref: string) {
    let nodes: SnapshotNode[];
    const activeTab: any = await getActiveTab(port).catch(() => ({ ok: false }));
    const activeTargetId = activeTab.ok ? activeTab.tab?.targetId || null : null;
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
    return page.getByRole(node.role, { name: node.name }).nth(node.occurrence || 0);
}

// ─── screenshot ────────────────────────────────

export async function screenshot(port: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    const type = opts.type || 'png';
    const filename = `screenshot_${Date.now()}.${type}`;
    const filepath = join(SCREENSHOTS_DIR, filename);

    const clip = normalizeClip(opts.clip);
    if (opts.ref && clip) throw new Error('screenshot cannot combine ref and clip');
    if (opts.ref) {
        const locator = await refToLocator(page, port, opts.ref);
        await locator.screenshot({ path: filepath, type });
    } else {
        await page.screenshot({ path: filepath, fullPage: opts.fullPage, type, ...(clip ? { clip } : {}) });
    }
    const dpr = await page.evaluate('window.devicePixelRatio');
    const viewport = page.viewportSize();
    return { path: filepath, dpr, viewport, ...(clip ? { clip } : {}) };
}

function normalizeClip(value: any): ClipRect | undefined {
    if (!value) return undefined;
    const clip = Array.isArray(value)
        ? { x: Number(value[0]), y: Number(value[1]), width: Number(value[2]), height: Number(value[3]) }
        : { x: Number(value.x), y: Number(value.y), width: Number(value.width), height: Number(value.height) };
    if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)) throw new Error('invalid clip');
    if (clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0) throw new Error('invalid clip');
    return clip;
}

// ─── actions ───────────────────────────────────

export async function click(port: number, ref: string, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    if (opts.doubleClick) await locator.dblclick();
    else await locator.click({ button: opts.button || 'left' });
    return { ok: true, url: page.url() };
}

export async function type(port: number, ref: string, text: string, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.fill(text);
    if (opts.submit) await page.keyboard.press('Enter');
    return { ok: true };
}

export async function press(port: number, key: string) {
    const page = await getActivePage(port);
    await page.keyboard.press(key);
    return { ok: true };
}

export async function hover(port: number, ref: string) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.hover();
    return { ok: true };
}

export async function navigate(port: number, url: string) {
    const page = await getActivePage(port);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    markBrowserStateChanged();
    return { ok: true, url: page.url() };
}

export async function evaluate(port: number, expression: string) {
    const page = await getActivePage(port);
    const result = await page.evaluate(expression);
    return { ok: true, result };
}

export async function getPageText(port: number, format = 'text') {
    const page = await getActivePage(port);
    if (format === 'html') return { text: await page.content() };
    return { text: await page.innerText('body') };
}

export async function getDom(port: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    const selector = String(opts.selector || 'body');
    if (!selector.trim() || selector.includes('\0')) throw new Error('invalid selector');
    const maxChars = Math.max(1, Number(opts.maxChars || opts['max-chars'] || DEFAULT_DOM_MAX_CHARS));
    const locator = page.locator(selector).first();
    const html = selector === 'body' ? await page.content() : await locator.evaluate((el: any) => el.outerHTML);
    const truncated = html.length > maxChars;
    return { html: truncated ? html.slice(0, maxChars) : html, selector, truncated, chars: Math.min(html.length, maxChars), totalChars: html.length };
}

export async function waitForSelector(port: number, selector: string, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    await page.waitForSelector(selector, {
        timeout: Number(opts.timeout || 30000),
        state: opts.state || 'visible',
    });
    return { ok: true };
}

export async function waitForText(port: number, text: string, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    await page.getByText(text).first().waitFor({ timeout: Number(opts.timeout || 30000), state: 'visible' });
    return { ok: true };
}

export async function reload(port: number) {
    const page = await getActivePage(port);
    await page.reload({ waitUntil: 'domcontentloaded' });
    markBrowserStateChanged();
    return { ok: true, url: page.url() };
}

export async function resize(port: number, width: number, height: number) {
    const page = await getActivePage(port);
    await page.setViewportSize({ width, height });
    markBrowserStateChanged();
    return { ok: true, viewport: page.viewportSize() };
}

export async function scroll(port: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    const x = Number(opts.x || 0);
    const y = Number(opts.y || 0);
    if (opts.ref) {
        const locator = await refToLocator(page, port, opts.ref);
        await locator.evaluate((el: any, delta: { x: number; y: number }) => el.scrollBy(delta.x, delta.y), { x, y });
    } else {
        await page.mouse.wheel(x, y);
    }
    return { ok: true };
}

export async function select(port: number, ref: string, values: string[]) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    const selected = await locator.selectOption(values);
    return { ok: true, selected };
}

export async function drag(port: number, fromRef: string, toRef: string) {
    const page = await getActivePage(port);
    const from = await refToLocator(page, port, fromRef);
    const to = await refToLocator(page, port, toRef);
    await from.dragTo(to);
    return { ok: true };
}

export async function mouseMove(port: number, x: number, y: number) {
    const page = await getActivePage(port);
    await page.mouse.move(x, y);
    return { ok: true };
}

export async function mouseDown(port: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    await page.mouse.down({ button: opts.button || 'left' });
    return { ok: true };
}

export async function mouseUp(port: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    await page.mouse.up({ button: opts.button || 'left' });
    return { ok: true };
}

function redactText(input: string, maxTextLength = 2000) {
    let text = input.slice(0, maxTextLength);
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[redacted]');
    return text;
}

async function ensureCaptureInstalled(port: number) {
    if (captureInstalled) return;
    const page = await getActivePage(port);
    page.on('console', (msg: any) => {
        consoleEntries.push({ type: msg.type(), text: redactText(msg.text()), ts: Date.now() });
        if (consoleEntries.length > 500) consoleEntries.shift();
    });
    page.on('request', (req: any) => {
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

export async function getConsole(port: number, opts: Record<string, any> = {}) {
    await ensureCaptureInstalled(port);
    if (opts.clear) consoleEntries.length = 0;
    const limit = Math.max(1, Number(opts.limit || 50));
    const maxTextLength = Math.max(1, Number(opts.maxTextLength || 2000));
    return { entries: consoleEntries.slice(-limit).map(e => ({ ...e, text: redactText(e.text, maxTextLength) })) };
}

export async function getNetwork(port: number, opts: Record<string, any> = {}) {
    await ensureCaptureInstalled(port);
    const limit = Math.max(1, Number(opts.limit || 50));
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
export async function mouseClick(port: number, x: number, y: number, opts: Record<string, any> = {}) {
    const page = await getActivePage(port);
    if (opts.doubleClick) await page.mouse.dblclick(x, y);
    else await page.mouse.click(x, y, { button: opts.button || 'left' });
    return { success: true, clicked: { x, y } };
}
