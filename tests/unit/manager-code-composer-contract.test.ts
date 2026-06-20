import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStrictPropertyAccess } from './source-normalize.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function read(path: string): string {
    return normalizeStrictPropertyAccess(readFileSync(join(root, path), 'utf8'));
}

test('code composer command palette preserves keyboard-first accessibility contract', () => {
    const composer = read('public/manager/src/code/CodeComposer.tsx');

    assert.ok(composer.includes('role="listbox"'), 'command palette must expose listbox semantics');
    assert.ok(composer.includes('role="option"'), 'command rows must expose option semantics');
    assert.ok(composer.includes('aria-activedescendant'), 'textarea must point at active command row');
    assert.ok(composer.includes('aria-selected'), 'active command row must be announced');
    assert.ok(composer.includes('aria-disabled'), 'disabled commands must be announced');
    assert.ok(composer.includes("e.key === 'ArrowDown'"), 'palette must handle ArrowDown');
    assert.ok(composer.includes("e.key === 'ArrowUp'"), 'palette must handle ArrowUp');
    assert.ok(composer.includes("e.key === 'Escape'"), 'palette must handle Escape');
    assert.ok(composer.includes("e.key === 'Enter' && !e.shiftKey"), 'palette must intercept Enter');
    assert.ok(composer.includes('selectCommand(activeCommand)'), 'Enter must select the active command while palette is open');
    assert.ok(composer.includes('props.onSubmit()'), 'normal Enter submit must remain available when palette is closed');
});

test('code composer command palette consumes normalized CodeCommand metadata', () => {
    const composer = read('public/manager/src/code/CodeComposer.tsx');
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const types = read('public/manager/src/code/code-types.ts');

    assert.ok(composer.includes('availableCommands: CodeCommand[]'), 'composer must receive normalized command DTOs');
    assert.ok(composer.includes('filterCodeCommands(props.availableCommands, props.inputText)'), 'composer must use shared filter helper');
    assert.ok(composer.includes('command.displayName'), 'palette must render normalized display name');
    assert.ok(composer.includes('command.category'), 'palette must render category metadata');
    assert.ok(composer.includes('command.source'), 'palette must render source metadata');
    assert.ok(composer.includes('commandActionLabel(command)'), 'palette must render action metadata');
    assert.ok(canvas.includes('normalizeCodeCommands(update.availableCommands)'), 'CodeCanvas must normalize ACP command updates');
    assert.ok(canvas.includes("command.actionType === 'popup' && command.popupKind"), 'CodeCanvas must route popup commands before text insertion');
    assert.ok(canvas.includes('setActivePopup({ kind: command.popupKind, command })'), 'popup command selection must open Code popup state');
    assert.ok(canvas.includes('setInputText(`${command.displayName} `)'), 'insert/pass-through command selection must still insert slash command text');
    assert.ok(types.includes("'anthropic'") === false, 'command registry types must not hardcode provider-only defaults');
});

test('code composer renders as one dense workbench dock with responsive controls', () => {
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const footer = read('public/manager/src/code/ComposerFooter.tsx');
    const cssEntry = read('public/manager/src/code/code.css');
    const css = read('public/manager/src/code/code-composer.css');
    const legacyCss = read('public/manager/src/code/code-workbench.css');

    assert.ok(cssEntry.includes("@import './code-composer.css';"), 'Code mode CSS entry must import the composer dock stylesheet');
    assert.ok(workbench.includes('className="code-composer-dock"'), 'workbench must wrap composer controls in a bottom dock');
    assert.ok(workbench.includes('className="code-composer-surface" aria-label="Code composer controls"'), 'dock must expose a single composer surface');
    assert.ok(workbench.indexOf('<CodeComposer') < workbench.indexOf('<ComposerFooter'), 'prompt input must sit above its setting controls inside the same surface');

    for (const token of ['title={provider}', 'title={model}', 'title={effort}', 'title={permissionDescriptions[permissionMode]}']) {
        assert.ok(footer.includes(token), `footer menu must preserve hover/readback title ${token}`);
    }
    assert.equal(footer.includes('<select'), false, 'footer controls must not use browser-native select dropdowns');
    assert.ok(footer.includes('aria-haspopup="listbox"'), 'footer menus must announce custom listbox popups');
    assert.ok(footer.includes('className="code-footer-dropup"'), 'footer menus must open as custom dropups above the composer');
    assert.ok(footer.includes("event.key === 'Escape'"), 'footer menus must close on Escape');
    assert.ok(footer.includes("event.key === 'ArrowDown'"), 'footer menus must support keyboard cycling');

    for (const selector of [
        '.code-composer-dock',
        '.code-composer-surface',
        '.code-footer-menu-trigger',
        '.code-footer-dropup',
        'bottom: calc(100% + 8px);',
        'flex-wrap: nowrap;',
        '.code-footer-field-model {',
        'text-overflow: ellipsis;',
        '@media (max-width: 720px)',
        '.code-composer-footer {',
    ]) {
        assert.ok(css.includes(selector), `composer stylesheet must include ${selector}`);
    }

    assert.equal(legacyCss.includes('.code-composer {'), false, 'composer layout styles must live in code-composer.css, not the workbench transient stylesheet');
    assert.ok(css.includes('grid-template-columns: minmax(0, 1fr) auto'), 'composer input and send button must have stable grid columns');
    assert.equal(css.includes('.code-composer-footer {\n        grid-template-columns: 1fr;'), false, 'narrow view must keep footer controls on one line');
});
