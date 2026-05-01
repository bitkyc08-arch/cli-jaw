import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';

const MANAGER_URL = process.env.MANAGER_DASHBOARD_URL || 'http://127.0.0.1:24576/';
const browsers: Browser[] = [];

async function pageForManager(): Promise<Page> {
    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const context = await browser.newContext();
    return await context.newPage();
}

async function seedRichNote(page: Page, notePath: string): Promise<void> {
    await page.evaluate(async ({ notePath }) => {
        const headers = { 'content-type': 'application/json' };
        await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath, notesViewMode: 'raw', notesAuthoringMode: 'plain' } }),
        });
        await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                path: notePath,
                content: [
                    '# Rich smoke',
                    '',
                    '$E = mc^2$',
                    '',
                    '```ts',
                    'const value = 1;',
                    '```',
                ].join('\n'),
            }),
        });
    }, { notePath });
}

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

test('notes rich authoring toggles renderer-backed CodeMirror widgets without becoming a view tab', async () => {
    const page = await pageForManager();
    const noteName = `browser-rich-${Date.now()}.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedRichNote(page, noteName);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    await page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first().click();
    await page.waitForSelector('.cm-content[contenteditable="true"]');
    assert.equal(await page.getByRole('tab', { name: 'Rich' }).count(), 0, 'Rich must not be a Notes view tab');

    await page.getByRole('button', { name: 'Rich', exact: true }).click();
    await page.waitForSelector('.cm-rich-widget', { timeout: 5000 });
    assert.ok(await page.locator('.cm-rich-widget').count() >= 1, 'Rich authoring must create renderer-backed widgets');

    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('tab', { name: 'Raw' }).click();
    await page.waitForSelector('.cm-rich-widget', { timeout: 5000 });

    await page.getByRole('button', { name: 'WYSIWYG', exact: true }).click();
    await page.waitForSelector('.notes-wysiwyg-toolbar', { timeout: 5000 });
    assert.ok(await page.locator('.notes-wysiwyg-toolbar button[title="Bold"]').count() === 1,
        'WYSIWYG authoring must expose visual formatting controls');
    await page.waitForSelector('.notes-milkdown-root .ProseMirror', { timeout: 5000 });
    await page.locator('.notes-milkdown-root .ProseMirror').click();
    await page.keyboard.type('\nMilkdown browser smoke edit');
    page.once('dialog', dialog => void dialog.accept('a^2 + b^2 = c^2'));
    await page.getByRole('button', { name: 'Inline math' }).click();
    await page.locator('.notes-math-inline-node').last().click();
    const inlineMathSource = page.locator('.notes-math-inline-node[data-editing="true"] input.notes-math-raw');
    await expectInputValue(inlineMathSource, '$a^2 + b^2 = c^2$');
    await inlineMathSource.fill('$a^2 + b^2 = c^2 + d^2$');
    await page.keyboard.press('Enter');
    page.once('dialog', dialog => void dialog.accept('\\int_0^1 x^2 dx'));
    await page.getByRole('button', { name: 'Block math' }).click();
    await page.locator('.notes-math-block-node').last().click();
    const blockMathSource = page.locator('.notes-math-block-node[data-editing="true"] textarea.notes-math-raw');
    await expectInputValue(blockMathSource, '$$\n\\int_0^1 x^2 dx\n$$');
    await blockMathSource.fill('$$\n\\int_0^1 x^2 dx = 1/3\n$$');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    page.once('dialog', dialog => void dialog.accept('ts'));
    await page.getByRole('button', { name: 'Code block' }).click();
    await page.waitForSelector('.notes-code-source-node[data-language="ts"]');
    await page.locator('.notes-code-source-node[data-language="ts"]').last().click();
    const codeSource = page.locator('.notes-code-source-node[data-editing="true"] textarea.notes-code-raw');
    await expectInputValueIncludes(codeSource, '```ts\n');
    await expectInputValueIncludes(codeSource, '\n```');
    await codeSource.fill('```ts\nconst milkdownCodeBlock = true;\n```');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.getByRole('button', { name: 'Save' }).click();

    const savedContent = await page.evaluate(async ({ noteName }) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(noteName)}`);
        const body = await response.json();
        return body.content as string;
    }, { noteName });
    assert.ok(savedContent.includes('$a^2 + b^2 = c^2 + d^2$'),
        'WYSIWYG inline math raw edits must round-trip back to canonical markdown');
    assert.ok(savedContent.includes('\\int_0^1 x^2 dx = 1/3'),
        'WYSIWYG block math raw edits must round-trip back to canonical markdown');
    assert.ok(savedContent.includes('```ts'),
        'WYSIWYG code blocks must preserve the selected language');
    assert.ok(savedContent.includes('const milkdownCodeBlock = true;'),
        'WYSIWYG code block content must round-trip back to canonical markdown');
});

async function expectInputValue(locator: Locator, expected: string): Promise<void> {
    const value = await locator.inputValue();
    assert.equal(value, expected);
}

async function expectInputValueIncludes(locator: Locator, expected: string): Promise<void> {
    const value = await locator.inputValue();
    assert.ok(value.includes(expected), `expected input value to include ${expected}`);
}
