import { getActivePage } from './connection.js';
import { CLAW_HOME } from '../config.js';
import { join } from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = join(CLAW_HOME, 'screenshots');

// ─── ref snapshot ────────────────────────────────

const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'checkbox',
    'radio', 'combobox', 'menuitem', 'tab', 'slider', 'searchbox',
    'option', 'switch', 'spinbutton'];

export async function snapshot(port, opts = {}) {
    const page = await getActivePage(port);
    if (!page) throw new Error('No active page');
    const tree = await page.accessibility.snapshot();
    const nodes = [];
    let counter = 0;

    function walk(node, depth = 0) {
        if (!node) return;
        counter++;
        const ref = `e${counter}`;
        if (!opts.interactive || INTERACTIVE_ROLES.includes(node.role)) {
            nodes.push({
                ref, role: node.role || 'unknown',
                name: node.name || '',
                ...(node.value ? { value: node.value } : {}),
                depth,
            });
        }
        for (const child of node.children || []) walk(child, depth + 1);
    }
    walk(tree);
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
