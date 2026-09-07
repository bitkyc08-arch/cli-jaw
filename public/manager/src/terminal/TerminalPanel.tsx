import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { hasFolderPanelDragPayload, readFolderPanelDragPayload, shellEscapePath } from '../folder-panel/folder-drag-payload';
import { getTerminalBridge } from './terminal-bridge';
import type { TerminalSessionSnapshot } from '../panels/desktop-bridge';
import { resolveTerminalTheme } from './terminal-theme';
import { takeTerminalShortcutQueue, TERMINAL_REQUEST_LIMIT, TERMINAL_QUEUE_OVERFLOW, TERMINAL_REVEAL_CONTROL_ID } from './terminal-shortcut-queue';
import './terminal.css';

type TermTab = {
    id: string;
    shell: string;
    cwd: string;
    ordinal: number;
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

const TERMINAL_TOMBSTONE_LIMIT = 128;
const PENDING_OUTPUT_IDS = 16;
const PENDING_OUTPUT_CHARS = 32_768;
const RESYNC_ERROR = 'Terminal events exceeded the recovery limit. Choose New terminal to resync sessions before creating.';
type SessionOperation = {
    kind: 'list' | 'create';
    generation: number;
    focusIntent: number;
    tombstones: Set<string>;
    lost: boolean;
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
    let compositionTimer: number | undefined;
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => {
        if (compositionTimer !== undefined) window.clearTimeout(compositionTimer);
        compositionTimer = window.setTimeout(() => {
            compositionTimer = undefined;
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
            if (compositionTimer !== undefined) window.clearTimeout(compositionTimer);
            if (watchedTextarea) {
                watchedTextarea.removeEventListener('input', flushTextareaValue);
                watchedTextarea.removeEventListener('compositionstart', onCompositionStart);
                watchedTextarea.removeEventListener('compositionend', onCompositionEnd);
            }
        },
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
    const [rovingId, setRovingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [isListing, setIsListing] = useState(false);
    const [theme, setTheme] = useState(() => resolveTerminalTheme(
        document.documentElement.dataset['theme'], window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false,
    ));
    const themeRef = useRef(theme);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const runtimesRef = useRef<Map<string, RuntimeTerminal>>(new Map());
    const pendingOutputRef = useRef<Map<string, string>>(new Map());
    const tabsRef = useRef<TermTab[]>([]);
    const activeIdRef = useRef<string | null>(null);
    const autoCreatedRef = useRef(false);
    const hydrationCompleteRef = useRef(false);
    const queuedNewSessionCountRef = useRef(0);
    const operationRef = useRef<SessionOperation | null>(null);
    const mountedRef = useRef(false);
    const generationRef = useRef(0);
    const epochRef = useRef(0);
    const focusIntentRef = useRef(0);
    const ordinalRef = useRef(0);
    const errorRef = useRef<string | null>(null);
    const emptyTimerRef = useRef<number | undefined>(undefined);
    const focusTimerRef = useRef<number | undefined>(undefined);
    const onEmptySessionsRef = useRef(props.onEmptySessions);
    onEmptySessionsRef.current = props.onEmptySessions;

    const reportError = useCallback((message: string | null) => {
        const bounded = message?.slice(0, 600) ?? null;
        errorRef.current = bounded;
        setError(bounded);
    }, []);
    const invalidateFocus = useCallback(() => {
        focusIntentRef.current += 1;
        if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = undefined;
    }, []);
    const setInventory = useCallback((next: TermTab[], selected: string | null) => {
        // Event/Promise callbacks must see the new inventory before React commits.
        tabsRef.current = next;
        activeIdRef.current = selected;
        epochRef.current += 1;
        setTabs(next);
        setActiveId(selected);
        setRovingId(current => next.some(tab => tab.id === current) ? current : selected);
    }, []);
    const notifyEmptySessionsSoon = useCallback(() => {
        if (emptyTimerRef.current !== undefined) window.clearTimeout(emptyTimerRef.current);
        const epoch = epochRef.current;
        const generation = generationRef.current;
        emptyTimerRef.current = window.setTimeout(() => {
            emptyTimerRef.current = undefined;
            if (!mountedRef.current || generation !== generationRef.current || epoch !== epochRef.current
                || tabsRef.current.length || queuedNewSessionCountRef.current || operationRef.current
                || errorRef.current) return;
            onEmptySessionsRef.current?.();
        }, 0);
    }, []);
    const visibleSurface = useCallback((id: string) => {
        const panel = panelRef.current;
        if (!mountedRef.current || !panel?.isConnected || activeIdRef.current !== id
            || panel.closest('[aria-hidden="true"], [hidden], [inert]')) return null;
        const node = Array.from(panel.querySelectorAll<HTMLElement>('.terminal-xterm-surface'))
            .find(surface => surface.dataset['terminalId'] === id);
        if (!node?.isConnected || !node.classList.contains('is-active') || node.getClientRects().length === 0) return null;
        return node;
    }, []);
    const fitTerminal = useCallback((id: string) => {
        const runtime = runtimesRef.current.get(id);
        if (!bridge || !runtime?.opened || !visibleSurface(id)) return;
        try {
            runtime.fit.fit();
            const generation = generationRef.current;
            void bridge.resize(id, runtime.term.cols, runtime.term.rows).catch(() => {
                if (mountedRef.current && generation === generationRef.current) reportError('Unable to resize terminal.');
            });
        } catch {
            reportError('Unable to fit terminal to the panel.');
        }
    }, [bridge, reportError, visibleSurface]);
    const focusSoon = useCallback((id: string, intent = focusIntentRef.current) => {
        if (intent !== focusIntentRef.current) return;
        if (focusTimerRef.current !== undefined) window.clearTimeout(focusTimerRef.current);
        const generation = generationRef.current;
        const epoch = epochRef.current;
        focusTimerRef.current = window.setTimeout(() => {
            focusTimerRef.current = undefined;
            if (generation !== generationRef.current || epoch !== epochRef.current
                || intent !== focusIntentRef.current || !visibleSurface(id)) return;
            fitTerminal(id);
            runtimesRef.current.get(id)?.term.focus();
        }, 0);
    }, [fitTerminal, visibleSurface]);
    const selectSession = useCallback((id: string) => {
        if (!tabsRef.current.some(tab => tab.id === id)) return;
        invalidateFocus();
        setInventory(tabsRef.current, id);
        setRovingId(id);
        focusSoon(id);
    }, [focusSoon, invalidateFocus, setInventory]);
    const disposeRuntime = useCallback((id: string) => {
        const runtime = runtimesRef.current.get(id);
        if (runtime) {
            for (const disposable of runtime.disposables) {
                try { disposable.dispose(); } catch { /* already disposed */ }
            }
            try { runtime.term.dispose(); } catch { /* already disposed */ }
            runtimesRef.current.delete(id);
        }
        pendingOutputRef.current.delete(id);
    }, []);
    const createRuntime = useCallback((id: string) => {
        if (!bridge || runtimesRef.current.has(id)) return;
        const term = new Terminal({
            cursorBlink: true, cursorStyle: 'block',
            fontFamily: "'Geist Mono', ui-monospace, 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
            fontSize: 12, lineHeight: 1.22, scrollback: 10_000, convertEol: false,
            theme: themeRef.current,
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
        if (pending) term.write(pending);
        pendingOutputRef.current.delete(id);
    }, [bridge]);
    const restoreSession = useCallback((snapshot: TerminalSessionSnapshot): TermTab => {
        const existing = tabsRef.current.find(tab => tab.id === snapshot.id);
        if (existing && runtimesRef.current.has(snapshot.id)) return existing;
        if (snapshot.buffer) pendingOutputRef.current.set(snapshot.id, snapshot.buffer);
        createRuntime(snapshot.id);
        return { id: snapshot.id, shell: snapshot.shell || 'sh', cwd: snapshot.cwd || '~', ordinal: existing?.ordinal ?? ++ordinalRef.current };
    }, [createRuntime]);
    const loseOperation = useCallback((operation: SessionOperation) => {
        operation.lost = true;
        operation.tombstones.clear();
        pendingOutputRef.current.clear();
        hydrationCompleteRef.current = false;
        queuedNewSessionCountRef.current = 0;
        reportError(RESYNC_ERROR);
    }, [reportError]);
    const recordExit = useCallback((id: string) => {
        const operation = operationRef.current;
        if (!operation || operation.lost || operation.tombstones.has(id)) return;
        // A delayed operation's lifetime is not a memory bound. Loss invalidates
        // its entire snapshot; evicting an ID could resurrect an exited shell.
        if (id.length > 256 || operation.tombstones.size >= TERMINAL_TOMBSTONE_LIMIT) {
            loseOperation(operation);
        } else operation.tombstones.add(id);
    }, [loseOperation]);
    const removeSession = useCallback((id: string) => {
        const index = tabsRef.current.findIndex(tab => tab.id === id);
        if (index < 0) return;
        const next = tabsRef.current.filter(tab => tab.id !== id);
        const selected = activeIdRef.current === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : activeIdRef.current;
        const wasActive = activeIdRef.current === id;
        if (wasActive) invalidateFocus();
        disposeRuntime(id);
        setInventory(next, selected);
        if (wasActive && selected) { setRovingId(selected); focusSoon(selected); }
        if (next.length === 0) notifyEmptySessionsSoon();
    }, [disposeRuntime, focusSoon, invalidateFocus, notifyEmptySessionsSoon, setInventory]);

    const flushQueuedNewSessions = useCallback(async () => {
        if (!bridge || !mountedRef.current || operationRef.current) return;
        const terminalBridge = bridge;
        const generation = generationRef.current;
        const isCurrent = () => mountedRef.current && generationRef.current === generation;
        const begin = (kind: SessionOperation['kind']): SessionOperation => {
            const operation = { kind, generation, focusIntent: focusIntentRef.current, tombstones: new Set<string>(), lost: false };
            operationRef.current = operation;
            epochRef.current += 1;
            return operation;
        };
        if (!hydrationCompleteRef.current) {
            const operation = begin('list');
            setIsListing(true);
            try {
                const result = await terminalBridge.list();
                if (!isCurrent() || operationRef.current !== operation || operation.lost) return;
                if (!result.ok) throw new Error(result.error ?? 'Failed to restore terminal sessions');
                const snapshots = (result.sessions ?? []).filter(snapshot => !operation.tombstones.has(snapshot.id));
                const restoredTabs = snapshots.map(restoreSession);
                for (const tab of tabsRef.current) if (!restoredTabs.some(restored => restored.id === tab.id)) disposeRuntime(tab.id);
                const selected = restoredTabs.some(tab => tab.id === activeIdRef.current)
                    ? activeIdRef.current : restoredTabs[restoredTabs.length - 1]?.id ?? null;
                setInventory(restoredTabs, selected);
                hydrationCompleteRef.current = true;
                reportError(null);
                if (selected) focusSoon(selected, operation.focusIntent);
                if (!restoredTabs.length && !queuedNewSessionCountRef.current && !autoCreatedRef.current) {
                    autoCreatedRef.current = true;
                    if (operation.tombstones.size === 0) queuedNewSessionCountRef.current = 1;
                }
            } catch (err) {
                if (!isCurrent() || operationRef.current !== operation || operation.lost) return;
                queuedNewSessionCountRef.current = 0;
                hydrationCompleteRef.current = false;
                reportError(`Unable to restore terminal sessions. Choose New terminal to retry. ${err instanceof Error ? err.message : ''}`.trim());
            } finally {
                operation.tombstones.clear();
                if (isCurrent() && operationRef.current === operation) {
                    operationRef.current = null;
                    pendingOutputRef.current.clear();
                    setIsListing(false);
                }
            }
            if (!isCurrent() || !hydrationCompleteRef.current) return;
        }
        while (isCurrent() && hydrationCompleteRef.current && queuedNewSessionCountRef.current > 0) {
            queuedNewSessionCountRef.current -= 1;
            const operation = begin('create');
            setIsCreating(true);
            try {
                const result = await bridge.create({ cols: 80, rows: 24 });
                if (!isCurrent() || operationRef.current !== operation || operation.lost) return;
                if (!result.ok || !result.id) throw new Error(result.error ?? 'Failed to start terminal session');
                if (operation.tombstones.has(result.id)) continue;
                createRuntime(result.id);
                const tab: TermTab = { id: result.id, shell: result.shell ?? 'sh', cwd: result.cwd ?? '~', ordinal: ++ordinalRef.current };
                reportError(null);
                setInventory([...tabsRef.current, tab], result.id);
                setRovingId(result.id);
                focusSoon(result.id, operation.focusIntent);
            } catch (err) {
                if (!isCurrent() || operationRef.current !== operation || operation.lost) return;
                queuedNewSessionCountRef.current = 0;
                reportError(`Unable to start terminal. ${err instanceof Error ? err.message : 'Choose New terminal to retry.'}`);
            } finally {
                operation.tombstones.clear();
                if (isCurrent() && operationRef.current === operation) {
                    operationRef.current = null;
                    pendingOutputRef.current.clear();
                    setIsCreating(false);
                }
            }
        }
        if (isCurrent() && tabsRef.current.length === 0) notifyEmptySessionsSoon();
    }, [bridge, createRuntime, disposeRuntime, focusSoon, notifyEmptySessionsSoon, reportError, restoreSession, setInventory]);
    const requestNewSession = useCallback(() => {
        if (!mountedRef.current || !bridge) return;
        const inFlightCreate = operationRef.current?.kind === 'create' ? 1 : 0;
        if (queuedNewSessionCountRef.current + inFlightCreate >= TERMINAL_REQUEST_LIMIT) {
            setNotice(TERMINAL_QUEUE_OVERFLOW);
            return;
        }
        // A lost snapshot must settle before an explicit resync can begin.
        if (operationRef.current?.lost) { reportError(RESYNC_ERROR); return; }
        epochRef.current += 1;
        queuedNewSessionCountRef.current += 1;
        if (!operationRef.current) { reportError(null); setNotice(null); }
        void flushQueuedNewSessions();
    }, [bridge, flushQueuedNewSessions, reportError]);
    const focusActiveTerminal = useCallback(() => {
        invalidateFocus();
        if (activeIdRef.current) focusSoon(activeIdRef.current);
        // Pending list/create may honor this explicit focus intent on completion.
        if (operationRef.current) operationRef.current.focusIntent = focusIntentRef.current;
    }, [focusSoon, invalidateFocus]);
    const drainPendingTerminalActions = useCallback(() => {
        const pending = takeTerminalShortcutQueue(window);
        for (const action of pending.actions) {
            if (action === 'focusTerminal') focusActiveTerminal();
            else if (action === 'newTerminalSession') requestNewSession();
        }
        if (pending.notice) setNotice(pending.notice);
    }, [focusActiveTerminal, requestNewSession]);
    const closeSession = useCallback((id: string) => {
        if (!bridge || !tabsRef.current.some(tab => tab.id === id)) return;
        const generation = generationRef.current;
        void bridge.kill(id).catch(() => {
            if (mountedRef.current && generation === generationRef.current) {
                hydrationCompleteRef.current = false;
                queuedNewSessionCountRef.current = 0;
                if (operationRef.current) loseOperation(operationRef.current);
                reportError('Unable to close terminal. Choose New terminal to resync.');
            }
        });
        recordExit(id);
        removeSession(id);
    }, [bridge, loseOperation, recordExit, removeSession, reportError]);

    const handleTerminalDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!hasFolderPanelDragPayload(event.dataTransfer)) return;
        if (!findTerminalSurface(event.target)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }, []);
    const handleTerminalDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (!bridge) return;
        const payload = readFolderPanelDragPayload(event.dataTransfer);
        if (!payload) return;
        const droppedPaths = payload.entries?.length ? payload.entries.map(entry => entry.path) : [payload.path];
        const surface = findTerminalSurface(event.target);
        const targetId = terminalIdFromSurface(surface);
        if (!targetId || !tabsRef.current.some(tab => tab.id === targetId)) return;
        event.preventDefault();
        event.stopPropagation();
        selectSession(targetId);
        void bridge.write(targetId, `${droppedPaths.map(shellEscapePath).join(' ')} `);
    }, [bridge, selectSession]);
    const attachHost = useCallback((id: string, node: HTMLDivElement | null) => {
        if (!node || !bridge) return;
        const runtime = runtimesRef.current.get(id);
        if (!runtime || runtime.opened) return;
        runtime.term.open(node);
        runtime.opened = true;
        runtime.disposables.push(createAccessibilityInputBridge(node, value => {
            void bridge.write(id, value);
        }));
    }, [bridge]);

    useEffect(() => {
        mountedRef.current = true;
        generationRef.current += 1;
        hydrationCompleteRef.current = false;
        autoCreatedRef.current = false;
        if (!bridge) return () => { mountedRef.current = false; };
        const offData = bridge.onData((id, data) => {
            const runtime = runtimesRef.current.get(id);
            if (runtime) { runtime.term.write(data); return; }
            const operation = operationRef.current;
            if (!operation || operation.lost || operation.tombstones.has(id)) return;
            const pending = pendingOutputRef.current.get(id) ?? '';
            if (id.length > 256 || (!pendingOutputRef.current.has(id) && pendingOutputRef.current.size >= PENDING_OUTPUT_IDS)
                || pending.length + data.length > PENDING_OUTPUT_CHARS) {
                loseOperation(operation);
                return;
            }
            pendingOutputRef.current.set(id, pending + data);
        });
        const offExit = bridge.onExit((id, code) => {
            recordExit(id);
            runtimesRef.current.get(id)?.term.writeln(`\r\n[process exited with code ${code ?? 'unknown'}]`);
            pendingOutputRef.current.delete(id);
            removeSession(id);
        });
        void flushQueuedNewSessions();
        return () => {
            offData();
            offExit();
            mountedRef.current = false;
            generationRef.current += 1;
            invalidateFocus();
            if (emptyTimerRef.current !== undefined) window.clearTimeout(emptyTimerRef.current);
            emptyTimerRef.current = undefined;
            operationRef.current = null;
            queuedNewSessionCountRef.current = 0;
            pendingOutputRef.current.clear();
            for (const id of Array.from(runtimesRef.current.keys())) disposeRuntime(id);
        };
    }, [bridge, disposeRuntime, flushQueuedNewSessions, invalidateFocus, loseOperation, recordExit, removeSession]);

    useEffect(() => {
        const media = window.matchMedia?.('(prefers-color-scheme: light)');
        const refresh = () => {
            const next = resolveTerminalTheme(document.documentElement.dataset['theme'], media?.matches ?? false);
            themeRef.current = next;
            setTheme(next);
            for (const runtime of runtimesRef.current.values()) {
                runtime.term.options.theme = next;
                if (runtime.opened) runtime.term.refresh(0, runtime.term.rows - 1);
            }
        };
        const observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        media?.addEventListener('change', refresh);
        refresh();
        return () => { observer.disconnect(); media?.removeEventListener('change', refresh); };
    }, []);
    useEffect(() => {
        function handleShortcutAction(e: Event) {
            const detail: unknown = (e as CustomEvent).detail;
            if (detail === 'closeTerminalTab' && activeIdRef.current) closeSession(activeIdRef.current);
            else if (detail === 'terminalClear' && activeIdRef.current) runtimesRef.current.get(activeIdRef.current)?.term.clear();
            else if (detail === 'focusTerminal') focusActiveTerminal();
            else if (detail === 'terminalNewTab' || detail === 'newTerminalSession') requestNewSession();
            else if (detail === 'flushTerminalShortcutQueue') drainPendingTerminalActions();
        }
        document.addEventListener('jaw:shortcut-action', handleShortcutAction);
        drainPendingTerminalActions();
        return () => document.removeEventListener('jaw:shortcut-action', handleShortcutAction);
    }, [closeSession, drainPendingTerminalActions, focusActiveTerminal, requestNewSession]);
    useEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        const visibility = new MutationObserver(() => {
            if (panel.closest('[aria-hidden="true"], [hidden], [inert]')) invalidateFocus();
        });
        const bottom = panel.closest('.bottom-panel');
        if (bottom) visibility.observe(bottom, { attributes: true, attributeFilter: ['aria-hidden', 'hidden', 'inert'] });
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            const id = activeIdRef.current;
            if (id) fitTerminal(id);
        });
        observer?.observe(panel);
        return () => { visibility.disconnect(); observer?.disconnect(); };
    }, [fitTerminal, invalidateFocus]);
    useEffect(() => {
        if (!activeId) return;
        fitTerminal(activeId);
        const selected = panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        selected?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [activeId, fitTerminal]);

    function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab'
            || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const index = buttons.indexOf(target as HTMLButtonElement);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        const button = buttons[next];
        if (!button) return;
        invalidateFocus();
        setRovingId(button.dataset['terminalTabId'] ?? null);
        button.focus();
        button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    function hidePanel() {
        invalidateFocus();
        props.onCollapse?.();
        document.getElementById(TERMINAL_REVEAL_CONTROL_ID)?.focus();
    }
    if (!bridge) return <div className="terminal-panel terminal-unavailable">Terminal requires Electron desktop app</div>;
    const activeTab = tabs.find(tab => tab.id === activeId);
    const statusText = activeTab?.cwd ?? (isCreating ? 'Starting shell...' : isListing ? 'Restoring sessions...' : 'No terminal sessions');
    const style = { '--terminal-background': theme.background, '--terminal-foreground': theme.foreground } as CSSProperties;
    const label = (tab: TermTab) => `${tab.ordinal}: ${tab.shell.split(/[\\/]/).pop() || 'sh'}`;

    return (
        <div className="terminal-panel" ref={panelRef} style={style}>
            <div className="terminal-tab-bar">
                <span className="terminal-heading">Terminal <span aria-label={`${tabs.length} sessions`}>{tabs.length}</span></span>
                <div className="terminal-session-tabs" role="tablist" aria-label="Terminal sessions" aria-orientation="horizontal" onKeyDown={handleTabKeyDown}>
                    {tabs.map(tab => (
                        <div key={tab.id} role="presentation" className={`terminal-tab-item ${tab.id === activeId ? 'is-active' : ''}`}>
                            <button type="button" className="terminal-tab" role="tab" id={`terminal-tab-${tab.ordinal}`}
                                aria-controls={`terminal-output-${tab.ordinal}`} aria-selected={tab.id === activeId}
                                data-terminal-tab-id={tab.id} tabIndex={tab.id === (rovingId ?? activeId) ? 0 : -1}
                                title={`${label(tab)} — ${tab.cwd}`} onFocus={invalidateFocus} onClick={() => selectSession(tab.id)}>
                                {label(tab)}
                            </button>
                            <button type="button" className="terminal-tab-close" aria-label={`Close ${label(tab)} session`}
                                title={`Close ${label(tab)} session`} onClick={() => closeSession(tab.id)}>
                                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
                            </button>
                        </div>
                    ))}
                </div>
                <button type="button" className="terminal-new-tab" aria-label="New terminal" disabled={isCreating} onClick={requestNewSession} title="New terminal (Ctrl+Shift+`)">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
                </button>
                <span className="terminal-status" title={statusText}>{statusText}</span>
                {props.onCollapse && <button type="button" className="terminal-collapse-button" aria-label="Collapse terminal panel"
                    title="Hide terminal panel — sessions keep running" onClick={hidePanel}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
                </button>}
            </div>
            <div className="terminal-xterm-host" aria-label="Terminal output">
                {tabs.map(tab => (
                    <div key={tab.id} ref={node => attachHost(tab.id, node)} data-terminal-id={tab.id}
                        role="tabpanel" id={`terminal-output-${tab.ordinal}`} aria-labelledby={`terminal-tab-${tab.ordinal}`}
                        aria-hidden={tab.id !== activeId} className={`terminal-xterm-surface${tab.id === activeId ? ' is-active' : ''}`}
                        onPointerDown={() => selectSession(tab.id)} onDragOver={handleTerminalDragOver} onDrop={handleTerminalDrop}>
                        <textarea className="terminal-a11y-input" aria-label="Terminal automation input" autoCapitalize="off" autoComplete="off"
                            autoCorrect="off" spellCheck={false} tabIndex={tab.id === activeId ? 0 : -1} />
                    </div>
                ))}
                {tabs.length === 0 && <div className="terminal-empty"><span>{statusText}</span>
                    <button type="button" disabled={isCreating} onClick={requestNewSession}>New terminal</button>
                </div>}
            </div>
            {(error || notice) && <div className="terminal-error" role="status">{[error, notice].filter(Boolean).join(' ')}</div>}
        </div>
    );
}
