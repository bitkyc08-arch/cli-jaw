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
        const registry = await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath, notesViewMode: 'raw', notesAuthoringMode: 'plain' } }),
        });
        if (!registry.ok) throw new Error(`registry seed failed: ${registry.status}`);
        const note = await fetch('/api/dashboard/notes/file', {
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
        if (!note.ok) throw new Error(`note seed failed: ${note.status}`);
    }, { notePath });
}

async function seedSimpleNote(page: Page, notePath: string): Promise<void> {
    await page.evaluate(async ({ notePath }) => {
        const headers = { 'content-type': 'application/json' };
        const registry = await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath, notesViewMode: 'raw', notesAuthoringMode: 'plain' } }),
        });
        if (!registry.ok) throw new Error(`registry seed failed: ${registry.status}`);
        const note = await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                path: notePath,
                content: ['# Task toolbar smoke', '', 'Simple note.'].join('\n'),
            }),
        });
        if (!note.ok) throw new Error(`note seed failed: ${note.status}`);
    }, { notePath });
}

async function seedGfmNote(page: Page, notePath: string, options: { includeFootnotes?: boolean } = {}): Promise<void> {
    await page.evaluate(async ({ notePath, includeFootnotes }) => {
        const headers = { 'content-type': 'application/json' };
        const registry = await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath, notesViewMode: 'raw', notesAuthoringMode: 'plain' } }),
        });
        if (!registry.ok) throw new Error(`registry seed failed: ${registry.status}`);
        const content = [
            '# GFM smoke',
            '',
            '- [ ] unchecked task',
            '- [x] checked task',
            '',
            '~~done later~~',
            '',
            '| Item | Status |',
            '| --- | --- |',
            '| GFM | works |',
            '',
            'Visit www.example.com',
        ];
        if (includeFootnotes) {
            content.push('', 'A note[^1]', '', '[^1]: footnote body');
        }
        const note = await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                path: notePath,
                content: content.join('\n'),
            }),
        });
        if (!note.ok) throw new Error(`note seed failed: ${note.status}`);
    }, { notePath, includeFootnotes: options.includeFootnotes !== false });
}

async function seedTaskOnlyNote(page: Page, notePath: string): Promise<void> {
    await page.evaluate(async ({ notePath }) => {
        const headers = { 'content-type': 'application/json' };
        const registry = await fetch('/api/dashboard/registry', {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ ui: { sidebarMode: 'notes', notesSelectedPath: notePath, notesViewMode: 'raw', notesAuthoringMode: 'plain' } }),
        });
        if (!registry.ok) throw new Error(`registry seed failed: ${registry.status}`);
        const note = await fetch('/api/dashboard/notes/file', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                path: notePath,
                content: [
                    '# Task smoke',
                    '',
                    '$a+b$',
                    '',
                    '```ts',
                    'const beforeTask = true;',
                    '```',
                    '',
                    '- [ ] existing task',
                ].join('\n'),
            }),
        });
        if (!note.ok) throw new Error(`note seed failed: ${note.status}`);
    }, { notePath });
}

after(async () => {
    await Promise.allSettled(browsers.map(browser => browser.close()));
});

test('notes WYSIWYG authoring keeps the primary toolbar compact', async () => {
    const page = await pageForManager();
    const noteName = `browser-rich-${Date.now()}.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedRichNote(page, noteName);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    await page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first().click();
    await page.waitForSelector('.cm-content[contenteditable="true"]');
    assert.equal(await page.getByRole('tab', { name: 'Rich' }).count(), 0, 'Rich must not be a Notes view tab');
    assert.equal(await page.getByRole('button', { name: 'Rich', exact: true }).count(), 0,
        'Rich legacy authoring must not be a primary toolbar button');

    await page.getByRole('tab', { name: 'Split' }).click();
    await page.keyboard.press('Control+E');
    assert.equal(await page.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected'), 'true',
        'Cmd/Ctrl+E from Split must skip Split and continue the Raw/Preview/WYSIWYG cycle');
    await page.keyboard.press('Control+E');
    assert.equal(await page.getByRole('tab', { name: 'WYSIWYG' }).getAttribute('aria-selected'), 'true',
        'Cmd/Ctrl+E must continue from Preview to WYSIWYG without selecting Split');
    await page.keyboard.press('Control+E');
    assert.equal(await page.getByRole('tab', { name: 'Raw' }).getAttribute('aria-selected'), 'true',
        'Cmd/Ctrl+E must continue from WYSIWYG back to Raw without selecting Split');
    await page.getByRole('tab', { name: 'Split' }).click();
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('tab', { name: 'Raw' }).click();
    await page.getByRole('tab', { name: 'WYSIWYG' }).click();
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
    await page.getByRole('heading', { name: 'Rich smoke' }).click();
    await expectNoOpenCodeSource(page,
        'clicking outside an open fenced code source must return it to rendered mode');
    await page.locator('.notes-code-source-node[data-language="ts"]').first().click();
    await expectInputValueIncludes(codeSource, 'const milkdownCodeBlock = true;');
    await codeSource.fill('```ts\nconst milkdownCodeBlock = true;\n```');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.notes-code-source-node[data-editing="true"]').count(), 0,
        'closed fenced code source followed by Enter must exit the raw block');
    assert.equal(
        await page.locator('.notes-code-source-node.ProseMirror-selectednode, .notes-code-source-node[data-selected="true"]').count(),
        0,
        'closed fenced code source exit must leave the code block unselected (no Cmd+A overlay)',
    );
    await page.keyboard.press('ArrowUp');
    await reopenedCodeSource(page).waitFor({ timeout: 2000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    const reopenedSource = reopenedCodeSource(page);
    await reopenedSource.waitFor({ timeout: 2000 });
    const reopenedValue = await reopenedSource.inputValue();
    assert.ok(reopenedValue.endsWith('```'),
        'Backspace from the line below a code block must re-open its raw textarea at end of source');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

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

test('notes WYSIWYG toolbar commands can be used together without conflicts', async () => {
    const page = await pageForManager();
    const noteName = `browser-toolbar-all-${Date.now()}.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedSimpleNote(page, noteName);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    await page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first().click();
    await page.getByRole('tab', { name: 'WYSIWYG' }).click();
    await page.waitForSelector('.notes-wysiwyg-toolbar', { timeout: 5000 });
    await page.waitForSelector('.notes-milkdown-root .ProseMirror', { timeout: 5000 });

    const editor = page.locator('.notes-milkdown-root .ProseMirror');
    await editor.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.type('bold toolbar');
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Italic' }).click();
    await page.keyboard.type('italic toolbar');
    await page.getByRole('button', { name: 'Italic' }).click();
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Strikethrough' }).click();
    await page.keyboard.type('strike toolbar');
    await page.getByRole('button', { name: 'Strikethrough' }).click();
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Inline code' }).click();
    await page.keyboard.type('code toolbar');
    await page.getByRole('button', { name: 'Inline code' }).click();
    await page.keyboard.press('Enter');

    page.once('dialog', dialog => dialog.accept('https://example.com/toolbar'));
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    page.once('dialog', dialog => dialog.accept('a+b'));
    await page.getByRole('button', { name: 'Inline math' }).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    page.once('dialog', dialog => dialog.accept('\\int_0^1 x dx'));
    await page.getByRole('button', { name: 'Block math' }).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Heading level 2' }).click();
    await page.keyboard.type('heading toolbar');
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Bullet list' }).click();
    await page.keyboard.type('bullet toolbar');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: 'Quote' }).click();
    await page.keyboard.type('quote toolbar');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    page.once('dialog', dialog => dialog.accept('ts'));
    await page.getByRole('button', { name: 'Code block' }).click();
    await page.keyboard.type('const toolbarCommand = true;');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await Promise.race([
        page.waitForSelector('.notes-wysiwyg-error', { timeout: 5000 }),
        page.waitForSelector('.notes-milkdown-root table', { timeout: 5000 }),
    ]);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const savedContent = await page.evaluate(async ({ noteName }) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(noteName)}`);
        const body = await response.json();
        return body.content as string;
    }, { noteName });

    assert.ok(savedContent.includes('bold toolbar'), 'Bold command must leave editable content intact');
    assert.ok(savedContent.includes('italic toolbar'), 'Italic command must leave editable content intact');
    assert.ok(savedContent.includes('strike toolbar'), 'Strikethrough command must leave editable content intact');
    assert.ok(savedContent.includes('code toolbar'), 'Inline code command must leave editable content intact');
    assert.ok(savedContent.includes('https://example.com/toolbar'), 'Link command must insert a safe URL');
    assert.ok(savedContent.includes('a+b'), 'Inline math command must insert math content');
    assert.ok(savedContent.includes('\\int_0^1 x dx'), 'Block math command must insert math content');
    assert.ok(savedContent.includes('heading toolbar'), 'Heading command must preserve typed content');
    assert.ok(savedContent.includes('bullet toolbar'), 'Bullet list command must preserve typed content');
    assert.ok(savedContent.includes('quote toolbar'), 'Quote command must preserve typed content');
    assert.ok(savedContent.includes('```ts'), 'Code block command must insert a language-aware fenced block');
    assert.ok(savedContent.includes('|'), 'Table command must insert table markdown');
});

test('notes WYSIWYG Task toolbar creates a usable checkbox without Milkdown task nodes', async () => {
    const page = await pageForManager();
    const noteName = `browser-task-toolbar-${Date.now()}.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedSimpleNote(page, noteName);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    await page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first().click();
    await page.getByRole('tab', { name: 'WYSIWYG' }).click();
    await page.waitForSelector('.notes-wysiwyg-toolbar', { timeout: 5000 });
    await page.getByRole('button', { name: 'Task list' }).click();
    await page.waitForSelector('.notes-wysiwyg-error', { timeout: 5000 });
    await page.waitForSelector('.cm-rich-task-widget input[type="checkbox"]', { timeout: 5000 });
    await page.locator('.cm-rich-task-widget input[type="checkbox"]').first().click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const savedContent = await page.evaluate(async ({ noteName }) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(noteName)}`);
        const body = await response.json();
        return body.content as string;
    }, { noteName });
    assert.ok(/(^|\n)- \[x\](\s|$)/.test(savedContent),
        'WYSIWYG Task toolbar checkbox must toggle and save through the CodeMirror widget');
});

test('notes render and edit GitHub Flavored Markdown affordances', async () => {
    const page = await pageForManager();
    const noteName = `browser-gfm-${Date.now()}.md`;
    const wysiwygNoteName = `browser-gfm-wysiwyg-${Date.now()}.md`;
    const taskOnlyNoteName = `browser-gfm-task-only-${Date.now()}.md`;

    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await seedGfmNote(page, noteName);
    await seedGfmNote(page, wysiwygNoteName, { includeFootnotes: false });
    await seedTaskOnlyNote(page, taskOnlyNoteName);
    await page.goto(MANAGER_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('.notes-tree');

    await page.locator('.notes-tree-file-button').filter({ hasText: noteName }).first().click();
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.waitForSelector('.notes-preview input[type="checkbox"]', { timeout: 5000 });
    assert.equal(await page.locator('.notes-preview input[type="checkbox"]').count(), 2,
        'Preview must render GFM task list checkboxes');
    assert.equal(await page.locator('.notes-preview input[type="checkbox"]:checked').count(), 1,
        'Preview must preserve checked GFM task list state');
    assert.equal(await page.locator('.notes-preview del').count(), 1,
        'Preview must render GFM strikethrough');
    assert.equal(await page.locator('.notes-preview table').count(), 1,
        'Preview must render GFM tables');
    assert.ok((await page.locator('.notes-preview a').first().getAttribute('href'))?.includes('www.example.com'),
        'Preview must autolink GFM URL literals');
    assert.equal(await page.locator('.notes-preview a[data-footnote-ref]').count(), 1,
        'Preview must render GFM footnote references');
    assert.equal(await page.locator('.notes-preview section.footnotes, .notes-preview [data-footnotes]').count(), 1,
        'Preview must render GFM footnote definitions');
    assert.equal(await page.locator('.notes-preview a[data-footnote-backref]').count(), 1,
        'Preview must render GFM footnote backrefs');

    await page.getByRole('tab', { name: 'WYSIWYG' }).click();
    await page.waitForSelector('.notes-wysiwyg-error', { timeout: 5000 });
    assert.equal(await page.locator('.notes-milkdown-root').count(), 0,
        'WYSIWYG must not mount Milkdown for notes with GFM footnotes until that path is safe');
    assert.ok((await page.locator('.notes-wysiwyg-error').textContent())?.includes('GFM task lists'),
        'unsafe GFM fallback must explain that GFM constructs are blocked');

    await page.locator('.notes-tree-file-button').filter({ hasText: wysiwygNoteName }).first().click();
    await page.waitForSelector('.notes-wysiwyg-error', { timeout: 5000 });
    assert.equal(await page.locator('.notes-milkdown-root').count(), 0,
        'WYSIWYG must not mount Milkdown for existing GFM task/table notes until that path is safe');

    await page.locator('.notes-tree-file-button').filter({ hasText: taskOnlyNoteName }).first().click();
    await page.getByRole('tab', { name: 'WYSIWYG' }).click();
    await page.waitForSelector('.notes-wysiwyg-error', { timeout: 5000 });
    await page.waitForSelector('.cm-rich-widget[data-rich-widget-kind="math-inline"]', { timeout: 5000 });
    await page.waitForSelector('.cm-rich-widget[data-rich-widget-kind="code"]', { timeout: 5000 });
    await page.waitForSelector('.cm-rich-task-widget input[type="checkbox"]', { timeout: 5000 });
    assert.equal(await page.locator('.notes-milkdown-root').count(), 0,
        'mixed rich/task notes must use sorted CodeMirror widgets instead of mounting Milkdown task nodes');

    const savedContent = await page.evaluate(async ({ noteName }) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(noteName)}`);
        const body = await response.json();
        return body.content as string;
    }, { noteName });
    assert.ok(/(^|\n)[-*] \[ \] unchecked task(\n|$)/.test(savedContent),
        'GFM task fallback must preserve unchecked task markdown');
    assert.ok(/(^|\n)[-*] \[[xX]\] checked task(\n|$)/.test(savedContent),
        'Existing checked GFM tasks must remain checked after WYSIWYG save');
    assert.ok(savedContent.includes('~~done later~~'),
        'GFM strikethrough must round-trip back to canonical markdown');
    assert.ok(/\|\s*Item\s*\|\s*Status\s*\|\s*\n\|[-:\s|]+\|\s*\n\|\s*GFM\s*\|\s*works\s*\|/.test(savedContent),
        'GFM tables must round-trip back to canonical markdown');
    const footnoteContent = await page.evaluate(async ({ noteName }) => {
        const response = await fetch(`/api/dashboard/notes/file?path=${encodeURIComponent(noteName)}`);
        const body = await response.json();
        return body.content as string;
    }, { noteName });
    assert.ok(footnoteContent.includes('A note[^1]') && footnoteContent.includes('[^1]: footnote body'),
        'GFM footnotes must round-trip back to markdown');
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

function reopenedCodeSource(page: Page): Locator {
    return page.locator('.notes-code-source-node[data-editing="true"] textarea.notes-code-raw');
}

async function expectNoOpenCodeSource(page: Page, message: string): Promise<void> {
    const deadline = Date.now() + 2000;
    let count = 0;
    while (Date.now() < deadline) {
        count = await page.locator('.notes-code-source-node[data-editing="true"]').count();
        if (count === 0) return;
        await page.waitForTimeout(25);
    }
    assert.equal(count, 0, message);
}

async function expectInputValueIncludes(locator: Locator, expected: string): Promise<void> {
    const value = await locator.inputValue();
    assert.ok(value.includes(expected), `expected input value to include ${expected}`);
}
