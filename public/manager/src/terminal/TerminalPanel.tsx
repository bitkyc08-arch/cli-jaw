import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import type { IDisposable, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { hasFolderPanelDragPayload, readFolderPanelDragPayload, shellEscapePath } from '../folder-panel/folder-drag-payload';
import { getTerminalBridge } from './terminal-bridge';
import type { TerminalSessionSnapshot } from '../panels/desktop-bridge';
import './terminal.css';

type TermTab = {
    id: string;
    shell: string;
    cwd: string;
};

type RuntimeTerminal = {
    term: Terminal;
    fit: FitAddon;
    disposables: IDisposable[];
    opened: boolean;
};

type TerminalPanelProps = {
    onCollapse?: () => void;
    onEmptySessions?: () => void;
};

const ACCESSIBILITY_INPUT_FLUSH_MS = 120;

type PendingTerminalAction = 'focusTerminal' | 'newTerminalSession';

type TerminalShortcutQueueWindow = Window & {
    __cliJawPendingTerminalActions?: PendingTerminalAction[];
};

function normalizeTerminalInputValue(value: string): string {
    return value.replace(/\r?\n/g, '\r');
}

function createAccessibilityInputBridge(
    node: HTMLDivElement,
    writeInput: (value: string) => void,
): IDisposable {
    let watchedTextarea: HTMLTextAreaElement | null = null;
    let composing = false;
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => {
        window.setTimeout(() => {
            composing = false;
            flushTextareaValue();
        }, 0);
    };
    const bindTextarea = (textarea: HTMLTextAreaElement) => {
        if (watchedTextarea === textarea) return;
        if (watchedTextarea) {
            watchedTextarea.removeEventListener('input', flushTextareaValue);
            watchedTextarea.removeEventListener('compositionstart', onCompositionStart);
            watchedTextarea.removeEventListener('compositionend', onCompositionEnd);
        }
        watchedTextarea = textarea;
        watchedTextarea.addEventListener('input', flushTextareaValue);
        watchedTextarea.addEventListener('compositionstart', onCompositionStart);
        watchedTextarea.addEventListener('compositionend', onCompositionEnd);
    };
    function flushTextareaValue() {
        const textarea = node.querySelector<HTMLTextAreaElement>('textarea.terminal-a11y-input');
        if (!textarea) return;
        bindTextarea(textarea);
        if (composing) return;
        const rawValue = textarea.value;
        if (!rawValue) return;
        textarea.value = '';
        const value = normalizeTerminalInputValue(rawValue);
        writeInput(value);
    }
    const interval = window.setInterval(flushTextareaValue, ACCESSIBILITY_INPUT_FLUSH_MS);
    flushTextareaValue();
    return {
        dispose: () => {
            window.clearInterval(interval);
            if (watchedTextarea) {
                watchedTextarea.removeEventListener('input', flushTextareaValue);
                watchedTextarea.removeEventListener('compositionstart', onCompositionStart);
                watchedTextarea.removeEventListener('compositionend', onCompositionEnd);
            }
        },
    };
}

function readTheme(): ITheme {
    return {
        background: '#0b1020',
        foreground: '#e5edf8',
        cursor: '#38bdf8',
        selectionBackground: 'rgba(56, 189, 248, 0.22)',
        black: '#0f172a',
        brightBlack: '#475569',
        red: '#ef4444',
        brightRed: '#f87171',
        green: '#22c55e',
        brightGreen: '#4ade80',
        yellow: '#eab308',
        brightYellow: '#facc15',
        blue: '#3b82f6',
        brightBlue: '#60a5fa',
        magenta: '#d946ef',
        brightMagenta: '#e879f9',
        cyan: '#06b6d4',
        brightCyan: '#22d3ee',
        white: '#e5e7eb',
        brightWhite: '#f8fafc',
    };
}

function findTerminalSurface(target: EventTarget | null): HTMLElement | null {
    const maybeElement = target as Partial<{ closest: (selector: string) => Element | null }> | null;
    const surface = typeof maybeElement?.closest === 'function'
        ? maybeElement.closest('.terminal-xterm-surface')
        : null;
    return surface instanceof HTMLElement ? surface : null;
}

function terminalIdFromSurface(surface: HTMLElement | null): string | null {
    return surface?.dataset['terminalId'] ?? null;
}

export function TerminalPanel(props: TerminalPanelProps = {}) {
    const bridge = getTerminalBridge();
    const [tabs, setTabs] = useState<TermTab[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const runtimesRef = useRef<Map<string, RuntimeTerminal>>(new Map());
    const pendingOutputRef = useRef<Map<string, string>>(new Map());
    const tabsRef = useRef<TermTab[]>(tabs);
    const activeIdRef = useRef<string | null>(activeId);
    const autoCreatedRef = useRef(false);
    const hydrationCompleteRef = useRef(false);
    const queuedNewSessionCountRef = useRef(0);
    const onEmptySessionsRef = useRef(props.onEmptySessions);

    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    onEmptySessionsRef.current = props.onEmptySessions;

    const notifyEmptySessionsSoon = useCallback(() => {
        window.setTimeout(() => onEmptySessionsRef.current?.(), 0);
    }, []);

    const fitTerminal = useCallback((id: string) => {
        const runtime = runtimesRef.current.get(id);
        if (!bridge || !runtime?.opened) return;
        try {
            runtime.fit.fit();
            void bridge.resize(id, runtime.term.cols, runtime.term.rows);
        } catch (err) {
            setError((err as Error).message);
        }
    }, [bridge]);

    const disposeRuntime = useCallback((id: string) => {
        const runtime = runtimesRef.current.get(id);
        if (!runtime) return;
        for (const disposable of runtime.disposables) {
            try { disposable.dispose(); } catch { /* ignore */ }
        }
        try { runtime.term.dispose(); } catch { /* ignore */ }
        runtimesRef.current.delete(id);
        pendingOutputRef.current.delete(id);
    }, []);

    const createRuntime = useCallback((id: string) => {
        if (!bridge || runtimesRef.current.has(id)) return;
        const term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
            fontSize: 12,
            lineHeight: 1.22,
            scrollback: 10_000,
            convertEol: false,
            theme: readTheme(),
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        const disposables = [
            term.onData(data => {
                void bridge.write(id, data);
            }),
            term.onResize(({ cols, rows }) => { void bridge.resize(id, cols, rows); }),
        ];
        runtimesRef.current.set(id, { term, fit, disposables, opened: false });
        const pending = pendingOutputRef.current.get(id);
        if (pending) {
            term.write(pending);
            pendingOutputRef.current.delete(id);
        }
    }, [bridge]);

    const createSession = useCallback(async () => {
        if (!bridge) return;
        setIsCreating(true);
        try {
            const result = await bridge.create({ cols: 80, rows: 24 });
            if (!result.ok || !result.id) {
                setError(result.error ?? 'Failed to start terminal session');
                return;
            }
            createRuntime(result.id);
            const tab: TermTab = { id: result.id, shell: result.shell ?? 'sh', cwd: result.cwd ?? '~' };
            setError(null);
            setTabs(prev => [...prev, tab]);
            setActiveId(result.id);
            window.setTimeout(() => {
                fitTerminal(result.id!);
                runtimesRef.current.get(result.id!)?.term.focus();
            }, 0);
        } finally {
            setIsCreating(false);
        }
    }, [bridge, createRuntime, fitTerminal]);

    const flushQueuedNewSessions = useCallback(() => {
        if (!hydrationCompleteRef.current) return;
        const count = queuedNewSessionCountRef.current;
        queuedNewSessionCountRef.current = 0;
        for (let i = 0; i < count; i += 1) {
            void createSession();
        }
    }, [createSession]);

    const requestNewSession = useCallback(() => {
        if (!hydrationCompleteRef.current) {
            queuedNewSessionCountRef.current += 1;
            return;
        }
        void createSession();
    }, [createSession]);

    const focusActiveTerminal = useCallback(() => {
        if (!activeIdRef.current) return;
        runtimesRef.current.get(activeIdRef.current)?.term.focus();
    }, []);

    const drainPendingTerminalActions = useCallback(() => {
        const win = window as TerminalShortcutQueueWindow;
        const actions = win.__cliJawPendingTerminalActions ?? [];
        win.__cliJawPendingTerminalActions = [];
        for (const action of actions) {
            if (action === 'focusTerminal') focusActiveTerminal();
            else if (action === 'newTerminalSession') requestNewSession();
        }
    }, [focusActiveTerminal, requestNewSession]);

    const restoreSession = useCallback((snapshot: TerminalSessionSnapshot): TermTab => {
        if (snapshot.buffer) pendingOutputRef.current.set(snapshot.id, snapshot.buffer);
        createRuntime(snapshot.id);
        return {
            id: snapshot.id,
            shell: snapshot.shell || 'sh',
            cwd: snapshot.cwd || '~',
        };
    }, [createRuntime]);

    const closeSession = useCallback((id: string) => {
        if (!bridge) return;
        void bridge.kill(id);
        disposeRuntime(id);
        setTabs(prev => {
            const next = prev.filter(tab => tab.id !== id);
            setActiveId(current => current === id ? (next[0]?.id ?? null) : current);
            if (prev.length > 0 && next.length === 0) notifyEmptySessionsSoon();
            return next;
        });
    }, [bridge, disposeRuntime, notifyEmptySessionsSoon]);

    const handleTerminalDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!hasFolderPanelDragPayload(event.dataTransfer)) return;
        const surface = findTerminalSurface(event.target);
        if (!surface) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleTerminalDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!bridge) return;
        const payload = readFolderPanelDragPayload(event.dataTransfer);
        if (!payload) return;
        const surface = findTerminalSurface(event.target);
        if (!surface) return;
        const targetId = terminalIdFromSurface(surface) ?? (surface.classList.contains('is-active') ? activeIdRef.current : null);
        if (!targetId) return;
        event.preventDefault();
        event.stopPropagation();
        setActiveId(targetId);
        void bridge.write(targetId, `${shellEscapePath(payload.path)} `);
        window.setTimeout(() => runtimesRef.current.get(targetId)?.term.focus(), 0);
    }, [bridge]);

    const attachHost = useCallback((id: string, node: HTMLDivElement | null) => {
        if (!node || !bridge) return;
        const runtime = runtimesRef.current.get(id);
        if (!runtime || runtime.opened) return;
        runtime.term.open(node);
        runtime.opened = true;
        runtime.disposables.push(createAccessibilityInputBridge(node, value => {
            void bridge.write(id, value);
        }));
        fitTerminal(id);
        if (activeIdRef.current === id) runtime.term.focus();
    }, [bridge, fitTerminal]);

    useEffect(() => {
        if (!bridge) return;
        const terminalBridge = bridge;
        let cancelled = false;
        hydrationCompleteRef.current = false;
        autoCreatedRef.current = false;

        async function hydrateSessions() {
            try {
                const result = await terminalBridge.list();
                if (cancelled) return;
                if (!result.ok) {
                    setError(result.error ?? 'Failed to restore terminal sessions');
                    hydrationCompleteRef.current = true;
                    flushQueuedNewSessions();
                    return;
                }

                const restoredTabs = (result.sessions ?? []).map(restoreSession);
                setTabs(restoredTabs);
                setActiveId(current => {
                    if (current && restoredTabs.some(tab => tab.id === current)) return current;
                    return restoredTabs[restoredTabs.length - 1]?.id ?? null;
                });
                hydrationCompleteRef.current = true;

                if (restoredTabs.length === 0 && queuedNewSessionCountRef.current === 0 && !autoCreatedRef.current) {
                    autoCreatedRef.current = true;
                    void createSession();
                    return;
                }
                flushQueuedNewSessions();
            } catch (err) {
                if (cancelled) return;
                setError((err as Error).message);
                hydrationCompleteRef.current = true;
                flushQueuedNewSessions();
            }
        }

        void hydrateSessions();
        return () => {
            cancelled = true;
        };
    }, [bridge, createSession, flushQueuedNewSessions, restoreSession]);

    useEffect(() => {
        if (!bridge) return;
        const offData = bridge.onData((id, data) => {
            const runtime = runtimesRef.current.get(id);
            if (runtime) {
                runtime.term.write(data);
                return;
            }
            pendingOutputRef.current.set(id, `${pendingOutputRef.current.get(id) ?? ''}${data}`);
        });
        const offExit = bridge.onExit((id, code) => {
            const runtime = runtimesRef.current.get(id);
            runtime?.term.writeln(`\r\n[process exited with code ${code ?? 'unknown'}]`);
            disposeRuntime(id);
            setTabs(prev => {
                const next = prev.filter(tab => tab.id !== id);
                if (prev.length > 0 && next.length === 0) notifyEmptySessionsSoon();
                return next;
            });
            setActiveId(prev => prev === id ? (tabsRef.current.find(tab => tab.id !== id)?.id ?? null) : prev);
        });
        return () => {
            offData();
            offExit();
            for (const id of Array.from(runtimesRef.current.keys())) {
                disposeRuntime(id);
            }
        };
    }, [bridge, disposeRuntime, notifyEmptySessionsSoon]);

    useEffect(() => {
        if (!activeId) return;
        window.setTimeout(() => {
            fitTerminal(activeId);
            runtimesRef.current.get(activeId)?.term.focus();
        }, 0);
    }, [activeId, fitTerminal]);

    useEffect(() => {
        function handleShortcutAction(e: Event) {
            const detail = (e as CustomEvent).detail;
            if (detail === 'closeTerminalTab' && activeIdRef.current) {
                closeSession(activeIdRef.current);
            } else if (detail === 'terminalClear' && activeIdRef.current) {
                const runtime = runtimesRef.current.get(activeIdRef.current);
                if (runtime) runtime.term.clear();
            } else if (detail === 'focusTerminal' && activeIdRef.current) {
                focusActiveTerminal();
            } else if (detail === 'terminalNewTab' || detail === 'newTerminalSession') {
                requestNewSession();
            } else if (detail === 'flushTerminalShortcutQueue') {
                drainPendingTerminalActions();
            }
        }
        document.addEventListener('jaw:shortcut-action', handleShortcutAction);
        drainPendingTerminalActions();
        return () => document.removeEventListener('jaw:shortcut-action', handleShortcutAction);
    }, [closeSession, drainPendingTerminalActions, focusActiveTerminal, requestNewSession]);

    useEffect(() => {
        if (!panelRef.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            const id = activeIdRef.current;
            if (id) fitTerminal(id);
        });
        observer.observe(panelRef.current);
        return () => observer.disconnect();
    }, [fitTerminal]);

    if (!bridge) {
        return <div className="terminal-panel terminal-unavailable">Terminal requires Electron desktop app</div>;
    }

    const activeTab = tabs.find(tab => tab.id === activeId);
    const statusText = activeTab?.cwd ?? (isCreating ? 'Starting shell...' : 'No terminal sessions');

    return (
        <div className="terminal-panel" ref={panelRef}>
            <div className="terminal-tab-bar">
                {tabs.map(tab => (
                    <div
                        key={tab.id}
                        className={`terminal-tab-item ${tab.id === activeId ? 'is-active' : ''}`}
                    >
                        <button
                            type="button"
                            className="terminal-tab"
                            onClick={() => setActiveId(tab.id)}
                        >
                            {tab.shell.split('/').pop()}
                        </button>
                        <button
                            type="button"
                            className="terminal-tab-close"
                            aria-label={`Close ${tab.shell.split('/').pop() ?? 'terminal'} session`}
                            title="Close terminal session"
                            onClick={() => closeSession(tab.id)}
                        >
                            ×
                        </button>
                    </div>
                ))}
                <button type="button" className="terminal-tab terminal-new-tab" aria-label="New terminal" disabled={isCreating} onClick={() => void createSession()}>+</button>
                <span className="terminal-status">{statusText}</span>
                {props.onCollapse && (
                    <button
                        type="button"
                        className="terminal-collapse-button"
                        aria-label="Collapse terminal panel"
                        title="Collapse terminal panel"
                        onClick={props.onCollapse}
                    >
                        ▼
                    </button>
                )}
            </div>
            <div className="terminal-xterm-host" aria-label="Terminal output">
                {tabs.map(tab => (
                    <div
                        key={tab.id}
                        ref={node => attachHost(tab.id, node)}
                        data-terminal-id={tab.id}
                        className={`terminal-xterm-surface${tab.id === activeId ? ' is-active' : ''}`}
                        onPointerDown={() => runtimesRef.current.get(tab.id)?.term.focus()}
                        onDragOver={handleTerminalDragOver}
                        onDrop={handleTerminalDrop}
                    >
                        <textarea
                            className="terminal-a11y-input"
                            aria-label="Terminal automation input"
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            tabIndex={tab.id === activeId ? 0 : -1}
                        />
                    </div>
                ))}
                {tabs.length === 0 && (
                    <div className="terminal-empty">
                        <button type="button" disabled={isCreating} onClick={() => void createSession()}>New terminal</button>
                    </div>
                )}
            </div>
            {error && <div className="terminal-error" role="status">{error}</div>}
        </div>
    );
}
