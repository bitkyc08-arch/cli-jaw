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
