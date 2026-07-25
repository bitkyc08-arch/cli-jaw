type NotesShortcutEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'target'>;

function hasPrimaryModifier(event: NotesShortcutEvent): boolean {
    return (event.metaKey || event.ctrlKey) && !event.altKey;
}

function isInsideNotesPalette(target: EventTarget | null): boolean {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
    return Boolean(target.closest('[data-notes-palette]'));
}

export function isQuickSwitcherShortcut(event: NotesShortcutEvent): boolean {
    return hasPrimaryModifier(event)
        && !event.shiftKey
        && event.key.toLowerCase() === 'p'
        && !isInsideNotesPalette(event.target);
}

export function isCommandPaletteShortcut(event: NotesShortcutEvent): boolean {
    return hasPrimaryModifier(event)
        && event.shiftKey
        && event.key.toLowerCase() === 'p'
        // Without this guard, Cmd+Shift+P inside an open quick switcher stacks a
        // second modal on top of it. The quick-switcher helper has always had the
        // guard; this one was missing it.
        && !isInsideNotesPalette(event.target);
}
