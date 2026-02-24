import { getActivePage, getCdpSession } from './connection.js';
import { CLAW_HOME } from '../config.js';
import { join } from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = join(CLAW_HOME, 'screenshots');

// ─── ref snapshot ────────────────────────────────

const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'checkbox',
    'radio', 'combobox', 'menuitem', 'tab', 'slider', 'searchbox',
    'option', 'switch', 'spinbutton'];

/**
 * Parse Playwright ariaSnapshot YAML into flat node list.
 * Format: "- role \"name\":" or "- role \"name\""
 */
function parseAriaYaml(yaml) {
    const nodes = [];
    let counter = 0;
    for (const line of yaml.split('\n')) {
        if (!line.trim() || !line.includes('-')) continue;
        const indent = line.search(/\S/);
        const depth = Math.floor(indent / 2);
        // Match: - role "name" or - role "name": or - text: content
        const m = line.match(/-\s+(\w+)(?:\s+"([^"]*)")?/);
        if (!m) continue;
        counter++;
        const role = m[1];
        const name = m[2] || '';
        nodes.push({ ref: `e${counter}`, role, name, depth });
    }
    return nodes;
}

/**
 * Parse CDP Accessibility.getFullAXTree response into flat node list.
 */
function parseCdpAxTree(axNodes) {
    const nodes = [];
    let counter = 0;
    // CDP returns flat list with parentId references; build depth map
    const depthMap = {};
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
    return nodes;
}

export async function snapshot(port, opts = {}) {
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
                `Snapshot failed.\n  ariaSnapshot: ${e1.message}\n  CDP fallback: ${e2.message}`
            );
        }
    }

    if (opts.interactive) {
        nodes = nodes.filter(n => INTERACTIVE_ROLES.includes(n.role));
    }

    return nodes;
}

// ─── ref → locator ─────────────────────────────

async function refToLocator(page, port, ref) {
    const nodes = await snapshot(port);
    const node = nodes.find(n => n.ref === ref);
    if (!node) throw new Error(`ref ${ref} not found — re-run snapshot`);
    return page.getByRole(node.role, { name: node.name });
}

// ─── screenshot ────────────────────────────────

export async function screenshot(port, opts = {}) {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    const type = opts.type || 'png';
    const filename = `screenshot_${Date.now()}.${type}`;
    const filepath = join(SCREENSHOTS_DIR, filename);

    if (opts.ref) {
        const locator = await refToLocator(page, port, opts.ref);
        await locator.screenshot({ path: filepath, type });
    } else {
        await page.screenshot({ path: filepath, fullPage: opts.fullPage, type });
    }
    return { path: filepath };
}

// ─── actions ───────────────────────────────────

export async function click(port, ref, opts = {}) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    if (opts.doubleClick) await locator.dblclick();
    else await locator.click();
    return { ok: true, url: page.url() };
}

export async function type(port, ref, text, opts = {}) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.fill(text);
    if (opts.submit) await page.keyboard.press('Enter');
    return { ok: true };
}

export async function press(port, key) {
    const page = await getActivePage(port);
    await page.keyboard.press(key);
    return { ok: true };
}

export async function hover(port, ref) {
    const page = await getActivePage(port);
    const locator = await refToLocator(page, port, ref);
    await locator.hover();
    return { ok: true };
}

export async function navigate(port, url) {
    const page = await getActivePage(port);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { ok: true, url: page.url() };
}

export async function evaluate(port, expression) {
    const page = await getActivePage(port);
    const result = await page.evaluate(expression);
    return { ok: true, result };
}

export async function getPageText(port, format = 'text') {
    const page = await getActivePage(port);
    if (format === 'html') return { text: await page.content() };
    return { text: await page.innerText('body') };
}

/** Click at pixel coordinates (vision-click support) */
export async function mouseClick(port, x, y, opts = {}) {
    const page = await getActivePage(port);
    if (opts.doubleClick) await page.mouse.dblclick(x, y);
    else await page.mouse.click(x, y);
    return { success: true, clicked: { x, y } };
}
