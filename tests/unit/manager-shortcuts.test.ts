import assert from 'node:assert/strict';
import test from 'node:test';
import {
    actionForShortcutEvent,
    DEFAULT_MANAGER_SHORTCUT_KEYMAP,
    formatShortcut,
    normalizeManagerShortcutKeymap,
    RENDERER_DISABLED_SHORTCUT_ACTIONS,
    shortcutMatches,
} from '../../public/manager/src/manager-shortcuts.js';

function keyEvent(key: string, modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>> = {}): KeyboardEvent {
    return {
        key,
        code: modifiers.code,
        altKey: modifiers.altKey === true,
        ctrlKey: modifiers.ctrlKey === true,
        metaKey: modifiers.metaKey === true,
        shiftKey: modifiers.shiftKey === true,
    } as KeyboardEvent;
}

test('manager shortcut matching requires exact modifiers and normalized keys', () => {
    assert.equal(shortcutMatches(keyEvent('i', { altKey: true }), 'Alt+I'), true);
    assert.equal(shortcutMatches(keyEvent('I', { altKey: true }), 'Alt+I'), true);
    assert.equal(shortcutMatches(keyEvent('i', { altKey: true, shiftKey: true }), 'Alt+I'), false);
    assert.equal(shortcutMatches(keyEvent('ArrowUp', { altKey: true }), 'Alt+ArrowUp'), true);
    assert.equal(shortcutMatches(keyEvent('n', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+N'), true);
});

test('manager shortcut action lookup uses the configured keymap', () => {
    assert.equal(
        actionForShortcutEvent(keyEvent('p', { altKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'focusActiveSession',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('j', { altKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'nextInstance',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('j', { ctrlKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        null,
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('~', { ctrlKey: true, shiftKey: true, code: 'Backquote' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'newTerminalSession',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('`', { ctrlKey: true, code: 'Backquote' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'focusTerminal',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('`', { metaKey: true, code: 'Backquote' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'focusTerminal',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('b', { metaKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'toggleRightPanel',
    );
    assert.equal(
        actionForShortcutEvent(keyEvent('b', { metaKey: true, shiftKey: true, code: 'KeyB' }), DEFAULT_MANAGER_SHORTCUT_KEYMAP),
        'toggleLeftSidebar',
    );
});

test('manager shortcut labels render readable chords', () => {
    assert.equal(formatShortcut('Alt+I'), 'Alt + I');
    assert.equal(formatShortcut('Ctrl + Shift + N'), 'Ctrl + Shift + N');
});

test('manager shortcut keymap normalizes legacy registry values', () => {
    const normalized = normalizeManagerShortcutKeymap({
        focusInstances: undefined,
        focusActiveSession: '',
        focusNotes: 'Ctrl+Shift+N',
    });

    assert.equal(normalized.focusInstances, DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusInstances);
    assert.equal(normalized.focusActiveSession, DEFAULT_MANAGER_SHORTCUT_KEYMAP.focusActiveSession);
    assert.equal(normalized.toggleRightPanel, 'Meta+B');
    assert.equal(normalized.focusTerminal, 'Ctrl+`');
    assert.equal(normalized.newTerminalSession, 'Ctrl+Shift+`');
    assert.equal(normalized.focusNotes, 'Ctrl+Shift+N');
    assert.equal(normalized.previousInstance, DEFAULT_MANAGER_SHORTCUT_KEYMAP.previousInstance);
    assert.equal(normalized.nextInstance, DEFAULT_MANAGER_SHORTCUT_KEYMAP.nextInstance);
    assert.equal(actionForShortcutEvent(keyEvent('i', { altKey: true }), undefined), 'focusInstances');
});

test('reload shortcuts are owned by the Electron menu and ignored by the renderer matcher', () => {
    // Default keymap binds Meta+R / Meta+Shift+R, but the renderer must not match
    // them (the Electron menu accelerator is the single source → no double reload).
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP), null);
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true, shiftKey: true }), DEFAULT_MANAGER_SHORTCUT_KEYMAP), null);

    // Even a persisted keymap explicitly carrying these bindings stays inert.
    const persisted = { ...DEFAULT_MANAGER_SHORTCUT_KEYMAP, browserReload: 'Meta+R', browserHardReload: 'Meta+Shift+R' };
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true }), persisted), null);
    assert.equal(actionForShortcutEvent(keyEvent('r', { metaKey: true, shiftKey: true }), persisted), null);

    assert.ok(RENDERER_DISABLED_SHORTCUT_ACTIONS.has('browserReload'));
    assert.ok(RENDERER_DISABLED_SHORTCUT_ACTIONS.has('browserHardReload'));
});
