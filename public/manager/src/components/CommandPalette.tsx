/* 10.6.10 — Lightweight command palette stub.
 *
 * Two sections: "Go to instance" (type-ahead over label/port using startsWith
 * + word-boundary contains) and "Actions" (top 5 fixed actions).
 * No fuzzy scoring, no plugin/skill API. Esc closes. Arrow keys navigate.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardInstance, DashboardUiTheme } from '../types';

type CommandAction = {
    id: string;
    label: string;
    hint?: string;
    run: () => void;
};

type CommandPaletteProps = {
    open: boolean;
    onClose: () => void;
    instances: DashboardInstance[];
    getLabel: (instance: DashboardInstance) => string;
    onSelectInstance: (instance: DashboardInstance) => void;
    theme: DashboardUiTheme;
    onCycleTheme: () => void;
    onRefresh: () => void;
    onToggleHidden: () => void;
    showHidden: boolean;
    onOpenSelected: () => void;
    selectedInstance: DashboardInstance | null;
};

const MAX_INSTANCE_RESULTS = 8;
const MAX_ACTION_RESULTS = 5;

function matchInstance(instance: DashboardInstance, label: string, query: string): boolean {
    if (!query) return true;
    const needle = query.toLowerCase();
    const candidates = [String(instance.port), label, instance.url, instance.workingDir, instance.currentCli];
    return candidates.some(value => {
        if (!value) return false;
        const haystack = String(value).toLowerCase();
        if (haystack.startsWith(needle)) return true;
        // word-boundary contains: any non-alphanum boundary then the needle
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(needle)}`, 'u').test(haystack);
    });
}

function escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function CommandPalette(props: CommandPaletteProps) {
    const [query, setQuery] = useState('');
    const [highlight, setHighlight] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (props.open) {
            setQuery('');
            setHighlight(0);
            requestAnimationFrame(() => inputRef.current?.focus());
        }
    }, [props.open]);

    useEffect(() => {
        if (!props.open) return undefined;
        function onKey(event: KeyboardEvent): void {
            if (event.key === 'Escape') {
                event.preventDefault();
                props.onClose();
            }
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [props.open, props.onClose]);

    const instanceResults = useMemo(() => {
        return props.instances
            .filter(instance => matchInstance(instance, props.getLabel(instance), query))
            .slice(0, MAX_INSTANCE_RESULTS);
    }, [props.instances, props.getLabel, query]);

    const actions = useMemo<CommandAction[]>(() => [
        { id: 'refresh', label: 'Refresh scan', hint: 'Re-scan local ports', run: props.onRefresh },
        {
            id: 'theme',
            label: `Theme: cycle (current ${props.theme})`,
            hint: 'Auto → Light → Dark',
            run: props.onCycleTheme,
        },
        {
            id: 'hidden',
            label: props.showHidden ? 'Hide hidden instances' : 'Show hidden instances',
            run: props.onToggleHidden,
        },
        ...(props.selectedInstance
            ? [{ id: 'open', label: `Open ${props.selectedInstance.url} in new tab`, run: props.onOpenSelected }]
            : []),
    ].slice(0, MAX_ACTION_RESULTS), [
        props.onRefresh,
        props.theme,
        props.onCycleTheme,
        props.showHidden,
        props.onToggleHidden,
        props.selectedInstance,
        props.onOpenSelected,
    ]);

    const flat = useMemo(() => {
        const out: Array<{ kind: 'instance'; instance: DashboardInstance } | { kind: 'action'; action: CommandAction }> = [];
        for (const instance of instanceResults) out.push({ kind: 'instance', instance });
        for (const action of actions) out.push({ kind: 'action', action });
        return out;
    }, [instanceResults, actions]);

    useEffect(() => {
        if (highlight >= flat.length) setHighlight(Math.max(0, flat.length - 1));
    }, [flat.length, highlight]);

    function activate(index: number): void {
        const item = flat[index];
        if (!item) return;
        if (item.kind === 'instance') {
            props.onSelectInstance(item.instance);
        } else {
            item.action.run();
        }
        props.onClose();
    }

    function onInputKey(event: React.KeyboardEvent<HTMLInputElement>): void {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlight(prev => Math.min(flat.length - 1, prev + 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlight(prev => Math.max(0, prev - 1));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            activate(highlight);
        }
    }

    if (!props.open) return null;

    return (
        <div className="command-palette-backdrop" role="presentation" onClick={props.onClose}>
            <div
                className="command-palette"
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
                onClick={event => event.stopPropagation()}
            >
                <input
                    ref={inputRef}
                    className="command-palette-input"
                    placeholder="Go to instance, or run an action…"
                    value={query}
                    onChange={event => { setQuery(event.target.value); setHighlight(0); }}
                    onKeyDown={onInputKey}
                    aria-label="Command query"
                />
                <div className="command-palette-list" ref={listRef}>
                    {instanceResults.length > 0 && (
                        <div className="command-palette-section" role="group" aria-label="Go to instance">
                            <header className="command-palette-section-header">Go to instance</header>
                            {instanceResults.map((instance, idx) => {
                                const flatIndex = idx;
                                const active = flatIndex === highlight;
                                return (
                                    <button
                                        key={instance.port}
                                        type="button"
                                        className={active ? 'command-palette-item is-active' : 'command-palette-item'}
                                        onMouseEnter={() => setHighlight(flatIndex)}
                                        onClick={() => activate(flatIndex)}
                                    >
                                        <span className="command-palette-port">:{instance.port}</span>
                                        <span className="command-palette-label">{props.getLabel(instance)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {actions.length > 0 && (
                        <div className="command-palette-section" role="group" aria-label="Actions">
                            <header className="command-palette-section-header">Actions</header>
                            {actions.map((action, idx) => {
                                const flatIndex = instanceResults.length + idx;
                                const active = flatIndex === highlight;
                                return (
                                    <button
                                        key={action.id}
                                        type="button"
                                        className={active ? 'command-palette-item is-active' : 'command-palette-item'}
                                        onMouseEnter={() => setHighlight(flatIndex)}
                                        onClick={() => activate(flatIndex)}
                                    >
                                        <span className="command-palette-label">{action.label}</span>
                                        {action.hint && <span className="command-palette-hint">{action.hint}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    {flat.length === 0 && (
                        <p className="command-palette-empty">No matches.</p>
                    )}
                </div>
                <footer className="command-palette-footer">
                    <span><kbd>↑↓</kbd> navigate</span>
                    <span><kbd>Enter</kbd> select</span>
                    <span><kbd>Esc</kbd> close</span>
                </footer>
            </div>
        </div>
    );
}
