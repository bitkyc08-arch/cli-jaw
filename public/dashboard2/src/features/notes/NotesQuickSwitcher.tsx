import { Search, X } from '@lucide/icons';
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { Icon } from '../../shell/Icon';
import { useModalA11y } from '../../shell/use-modal-a11y.ts';
import type { NoteMetadata } from './notes-types';

export type NotesQuickSwitcherProps = {
    open: boolean;
    notes: NoteMetadata[] | null;
    onClose: () => void;
    onSelect: (path: string) => void;
};

const MAX_RESULTS = 10;

export function NotesQuickSwitcher(props: NotesQuickSwitcherProps): JSX.Element | null {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    // M4 — the backdrop blocks the pointer; inert blocks keyboard and AT.
    useModalA11y('.d2-notes-modal-backdrop', { inert: true, restore: false, active: props.open });
    const results = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return (props.notes ?? [])
            .filter(note => !needle || note.title.toLowerCase().includes(needle) || note.path.toLowerCase().includes(needle))
            .slice(0, MAX_RESULTS);
    }, [props.notes, query]);

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

    function select(path: string): void {
        props.onSelect(path);
        props.onClose();
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
            select(results[activeIndex].path);
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
    const activeId = results[activeIndex] ? `d2-notes-switcher-result-${activeIndex}` : undefined;

    return (
        <div className="d2-notes-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
            <div ref={dialogRef} className="d2-notes-quick-switcher" data-notes-palette="switcher" role="dialog" aria-modal="true" aria-label="Quick switch note" onKeyDown={handleKeyDown}>
                <div className="d2-notes-modal-search">
                    <Icon icon={Search} size={16} />
                    <input ref={inputRef} type="search" value={query} placeholder="Search notes" aria-label="Search notes" aria-controls="d2-notes-switcher-results" aria-activedescendant={activeId} onChange={event => { setQuery(event.currentTarget.value); setActiveIndex(0); }} />
                    <button type="button" aria-label="Close quick switcher" onClick={props.onClose}><Icon icon={X} size={15} /></button>
                </div>
                <div id="d2-notes-switcher-results" className="d2-notes-modal-results" role="listbox" aria-label="Matching notes">
                    {results.map((note, index) => (
                        <button id={`d2-notes-switcher-result-${index}`} key={note.path} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} onMouseEnter={() => setActiveIndex(index)} onClick={() => select(note.path)}>
                            <span className="d2-notes-result-title">{note.title || note.path}</span>
                            <span className="d2-notes-result-path">{note.path}</span>
                        </button>
                    ))}
                    {results.length === 0 ? <p className="d2-notes-modal-empty">No matching notes</p> : null}
                </div>
            </div>
        </div>
    );
}
