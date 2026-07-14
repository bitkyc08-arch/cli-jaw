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
    return hasPrimaryModifier(event) && event.shiftKey && event.key.toLowerCase() === 'p';
}
