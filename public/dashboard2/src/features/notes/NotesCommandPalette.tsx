import { Command, Search, X } from '@lucide/icons';
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { Icon } from '../../shell/Icon';
import { useNoteCommands, type NoteCommand } from './notes-command-registry';

export type NotesCommandPaletteProps = {
    open: boolean;
    onClose: () => void;
};

export function NotesCommandPalette(props: NotesCommandPaletteProps): JSX.Element | null {
    const commands = useNoteCommands();
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const results = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return commands.filter(command => !needle || command.label.toLowerCase().includes(needle));
    }, [commands, query]);

    useEffect(() => {
        if (!props.open) return;
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setQuery('');
        setActiveIndex(0);
        requestAnimationFrame(() => inputRef.current?.focus());
        return () => previousFocusRef.current?.focus();
    }, [props.open]);

    useEffect(() => {
        if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1));
    }, [activeIndex, results.length]);

    function execute(command: NoteCommand): void {
        if (command.disabled) return;
        props.onClose();
        try {
            void Promise.resolve(command.run()).catch(error => console.warn('[notes-command-palette]', error));
        } catch (error) {
            console.warn('[notes-command-palette]', error);
        }
    }

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            props.onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setActiveIndex(index => results.length ? (index + delta + results.length) % results.length : 0);
        } else if (event.key === 'Enter' && results[activeIndex]) {
            event.preventDefault();
            execute(results[activeIndex]);
        } else if (event.key === 'Tab') {
            const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])];
            if (focusable.length === 0) return;
            const current = focusable.indexOf(document.activeElement as HTMLElement);
            const next = event.shiftKey ? (current - 1 + focusable.length) % focusable.length : (current + 1) % focusable.length;
            event.preventDefault();
            focusable[next]?.focus();
        }
    }

    if (!props.open) return null;
    const activeId = results[activeIndex] ? `d2-notes-command-${activeIndex}` : undefined;

    return (
        <div className="d2-notes-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
            <div ref={dialogRef} className="d2-notes-command-palette" data-notes-palette="command" role="dialog" aria-modal="true" aria-label="Notes command palette" onKeyDown={handleKeyDown}>
                <div className="d2-notes-modal-search">
                    <Icon icon={Search} size={16} />
                    <input ref={inputRef} type="search" value={query} placeholder="Run a command" aria-label="Filter commands" aria-controls="d2-notes-command-results" aria-activedescendant={activeId} onChange={event => { setQuery(event.currentTarget.value); setActiveIndex(0); }} />
                    <button type="button" aria-label="Close command palette" onClick={props.onClose}><Icon icon={X} size={15} /></button>
                </div>
                <div id="d2-notes-command-results" className="d2-notes-modal-results" role="listbox" aria-label="Available commands">
                    {results.map((command, index) => (
                        <button id={`d2-notes-command-${index}`} key={command.id} type="button" role="option" aria-selected={index === activeIndex} aria-disabled={command.disabled || undefined} className={`${index === activeIndex ? 'active' : ''}${command.disabled ? ' disabled' : ''}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => execute(command)}>
                            <Icon icon={Command} size={14} />
                            <span className="d2-notes-result-title">{command.label}</span>
                            <span className="d2-notes-command-section">{command.disabledReason || command.section}</span>
                            {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
                        </button>
                    ))}
                    {results.length === 0 ? <p className="d2-notes-modal-empty">No matching commands</p> : null}
                </div>
            </div>
        </div>
    );
}
