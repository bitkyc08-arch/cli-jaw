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
                    '$$',
                    '\\int_0^1 x^2 dx',
                    '$$',
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
    await page.waitForSelector('.notes-math-inline-node', { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.locator('.notes-math-inline-node').first().click();
    const inlineMathSource = page.locator('.notes-math-inline-node[data-editing="true"] input.notes-math-raw');
    await expectInputValue(inlineMathSource, '$E = mc^2$');
    await inlineMathSource.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' + e');
    await expectInputValue(inlineMathSource, '$E = mc^2$ + e');
    await inlineMathSource.fill('$a^2 + b^2 = c^2 + d^2$');
    await page.keyboard.press('Enter');
    await page.locator('.notes-math-block-node').first().click();
    const blockMathSource = page.locator('.notes-math-block-node[data-editing="true"] textarea.notes-math-raw');
    await expectInputValue(blockMathSource, '$$\n\\int_0^1 x^2 dx\n$$');
    await blockMathSource.fill('$$\n\\int_0^1 x^2 dx = 1/3\n$$');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.notes-math-block-node[data-editing="true"]').count(), 0,
        'closed block math source followed by Enter must exit the raw block');
    await page.waitForSelector('.notes-code-source-node[data-language="ts"]');
    await page.locator('.notes-code-source-node[data-language="ts"]').first().click();
    const codeSource = page.locator('.notes-code-source-node[data-editing="true"] textarea.notes-code-raw');
    await expectInputValueIncludes(codeSource, '```ts\n');
    await expectInputValueIncludes(codeSource, '\n```');
    await codeSource.fill('```ts\nconst milkdownCodeBlock = true;\n```');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.notes-code-source-node[data-editing="true"]').count(), 0,
        'closed fenced code source followed by Enter must exit the raw block');
    assert.equal(
        await page.locator('.notes-code-source-node.ProseMirror-selectednode, .notes-code-source-node[data-selected="true"]').count(),
        0,
        'closed fenced code source exit must leave the code block unselected (no Cmd+A overlay)',
    );
    await page.keyboard.press('Backspace');
    const reopenedSource = page.locator('.notes-code-source-node[data-editing="true"] textarea.notes-code-raw');
    await reopenedSource.waitFor({ timeout: 2000 });
    const reopenedValue = await reopenedSource.inputValue();
    assert.ok(reopenedValue.endsWith('```'),
        'Backspace from the line below a code block must re-open its raw textarea at end of source');
    await page.keyboard.press('Escape');
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
    // Replace Playwright's auto-wait inputValue (which has shown flake under
    // tsx --test for inline math node views even when the underlying DOM is
    // ready) with an explicit deadline-based poll over a fresh evaluate read.
    const deadline = Date.now() + 5000;
    let value = '';
    while (Date.now() < deadline) {
        value = await locator.evaluate(el => (el as HTMLInputElement | HTMLTextAreaElement).value ?? '').catch(() => '');
        if (value === expected) {
            assert.equal(value, expected);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(value, expected);
}

async function expectInputValueIncludes(locator: Locator, expected: string): Promise<void> {
    const value = await locator.inputValue();
    assert.ok(value.includes(expected), `expected input value to include ${expected}`);
}
