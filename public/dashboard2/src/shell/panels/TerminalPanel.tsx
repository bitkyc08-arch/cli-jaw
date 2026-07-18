import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { useDesktopBridge } from '../../providers/desktop-bridge-provider.tsx';
import {
    MAX_TERMINAL_SESSIONS,
    TerminalSessionController,
    terminalTargetMatches,
    type TerminalRuntime,
    type TerminalSessionSnapshot,
    type TerminalTarget,
} from './terminal-session-state.ts';
import type { TerminalRequestLedger } from './terminal-session-requests.ts';

interface TerminalPanelProps {
    port: number | null;
    workingDirectory: TerminalTarget | null;
    workingDirectoryError?: string | null;
    terminalRequests: TerminalRequestLedger;
    consumeTerminalRequests(token: number): void;
    consumeTerminalFocus(token: number): void;
}

const EMPTY_SNAPSHOT: TerminalSessionSnapshot = {
    sessions: [],
    activeSessionKey: null,
    creating: false,
    hydrating: false,
    queuedRequests: 0,
    rejection: null,
};

function createXtermRuntime(_key: string, onInput: (data: string) => void): TerminalRuntime {
    const terminal = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, monospace',
        fontSize: 13,
        theme: {
            background: '#0a0a0a',
            foreground: '#d4d4d4',
            cursor: '#f5f5f5',
            selectionBackground: '#264f78',
        },
    });
    const fitAddon = new FitAddon();
    const inputDisposable = terminal.onData(onInput);
    terminal.loadAddon(fitAddon);
    let host: HTMLElement | null = null;
    let opened = false;
    let disposed = false;

    return {
        open(node) {
            if (opened || disposed) return;
            host = node;
            terminal.open(node);
            opened = true;
        },
        write: (data) => terminal.write(data),
        writeln: (data) => terminal.writeln(data),
        clear: () => terminal.clear(),
        focus: () => terminal.focus(),
        fit() {
            if (!opened || disposed || !host?.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
                return null;
            }
            fitAddon.fit();
            if (terminal.cols <= 0 || terminal.rows <= 0) return null;
            return { cols: terminal.cols, rows: terminal.rows };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            inputDisposable.dispose();
            terminal.dispose();
            host = null;
        },
    };
}

function shellLabel(shell: string, ordinal: number): string {
    const name = shell.split('/').filter(Boolean).pop();
    return name && name !== 'shell' ? `${name} ${ordinal}` : `Terminal ${ordinal}`;
}

export function TerminalPanel({
    port,
    workingDirectory,
    workingDirectoryError = null,
    terminalRequests,
    consumeTerminalRequests,
    consumeTerminalFocus,
}: TerminalPanelProps): JSX.Element {
    const bridge = useDesktopBridge();
    const viewportRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<TerminalSessionController | null>(null);
    const handledRequestTokenRef = useRef(terminalRequests.newTab.consumed);
    const [snapshot, setSnapshot] = useState<TerminalSessionSnapshot>(EMPTY_SNAPSHOT);
    const nativeTerminal = bridge.terminal.nativeAvailable ? bridge.terminal.native : null;

    useEffect(() => {
        if (!nativeTerminal) {
            setSnapshot(EMPTY_SNAPSHOT);
            return;
        }
        const controller = new TerminalSessionController(nativeTerminal, createXtermRuntime);
        controllerRef.current = controller;
        const unsubscribe = controller.subscribe(setSnapshot);
        return () => {
            controllerRef.current = null;
            unsubscribe();
            // Always detach (park): remount/reload hydrates parked PTYs back.
            // Close-all belongs to main (owner destroyed / app quit) or an
            // explicit dispose() command — never to unmount (S3).
            controller.detach();
        };
    }, [nativeTerminal]);

    useEffect(() => {
        const controller = controllerRef.current;
        if (!controller) return;
        const target = terminalTargetMatches(port, workingDirectory) ? workingDirectory : null;
        const targetChanged = controller.setTarget(target);
        handledRequestTokenRef.current = Math.max(
            handledRequestTokenRef.current,
            terminalRequests.newTab.consumed,
        );
        if (!target) return;

        const pendingRequestCount = terminalRequests.newTab.issued - handledRequestTokenRef.current;
        if (pendingRequestCount > 0) {
            handledRequestTokenRef.current = terminalRequests.newTab.issued;
            controller.requestNewSessions(pendingRequestCount);
            consumeTerminalRequests(terminalRequests.newTab.issued);
        } else if (targetChanged && controller.getSnapshot().sessions.length === 0) {
            controller.requestAutoSession();
        }
    }, [
        consumeTerminalRequests,
        port,
        terminalRequests.newTab.consumed,
        terminalRequests.newTab.issued,
        workingDirectory,
    ]);

    useEffect(() => {
        const controller = controllerRef.current;
        if (!controller) return;
        const pendingFocus = terminalRequests.focus.issued - terminalRequests.focus.consumed;
        if (pendingFocus <= 0) return;
        // Drain focus only after hydration settled and a live session exists (R6).
        if (snapshot.hydrating || snapshot.creating) return;
        const active = snapshot.sessions.find(session => session.key === snapshot.activeSessionKey);
        if (!active?.sessionId || active.status !== 'running') return;
        controller.focusActive();
        // Drain exactly one token per focus call; the effect re-runs for the rest.
        consumeTerminalFocus(terminalRequests.focus.consumed + 1);
    }, [
        consumeTerminalFocus,
        snapshot,
        terminalRequests.focus.consumed,
        terminalRequests.focus.issued,
    ]);

    useEffect(() => {
        const shortcuts = bridge.shell.shortcuts.nativeAvailable ? bridge.shell.shortcuts.native : null;
        if (!shortcuts) return;
        return shortcuts.onAction((action) => {
            if (action === 'terminalClear') controllerRef.current?.clearActive();
        });
    }, [bridge.shell.shortcuts.native, bridge.shell.shortcuts.nativeAvailable]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || typeof ResizeObserver === 'undefined') return;
        const resize = (): void => controllerRef.current?.resizeActive();
        const frame = requestAnimationFrame(resize);
        const observer = new ResizeObserver(resize);
        observer.observe(viewport);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [nativeTerminal]);

    useEffect(() => {
        if (!snapshot.activeSessionKey) return;
        const frame = requestAnimationFrame(() => controllerRef.current?.resizeActive());
        return () => cancelAnimationFrame(frame);
    }, [
        snapshot.activeSessionKey,
        snapshot.sessions.find((session) => session.key === snapshot.activeSessionKey)?.sessionId,
    ]);

    const requestSession = useCallback(() => controllerRef.current?.requestNewSessions(1), []);
    const activeSession = snapshot.sessions.find((session) => session.key === snapshot.activeSessionKey) ?? null;

    const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, key: string) => {
        const currentIndex = snapshot.sessions.findIndex((session) => session.key === key);
        if (currentIndex < 0) return;
        let nextIndex = currentIndex;
        if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + snapshot.sessions.length) % snapshot.sessions.length;
        else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % snapshot.sessions.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = snapshot.sessions.length - 1;
        else return;
        event.preventDefault();
        const next = snapshot.sessions[nextIndex];
        if (!next) return;
        controllerRef.current?.activateSession(next.key);
        document.getElementById(`terminal-tab-${next.key}`)?.focus();
    }, [snapshot.sessions]);

    if (!nativeTerminal) {
        return <div className="d2-terminal-panel" role="status">Terminal requires the cli-jaw Electron app</div>;
    }
    if (port === null) {
        return <div className="d2-terminal-panel" role="status">No instance selected</div>;
    }
    if (workingDirectoryError) {
        return <div className="d2-terminal-panel" role="alert">{workingDirectoryError}</div>;
    }
    if (!terminalTargetMatches(port, workingDirectory)) {
        return <div className="d2-terminal-panel" role="status" aria-busy="true">Loading terminal working directory…</div>;
    }

    return (
        <div
            className="d2-terminal-panel"
            aria-label={`Terminal for instance ${port}`}
            style={{ display: 'grid', gridTemplateRows: '32px minmax(0, 1fr) auto', gap: 4, background: '#0a0a0a' }}
        >
            <div
                role="tablist"
                aria-label="Terminal sessions"
                style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflowX: 'auto' }}
            >
                {snapshot.sessions.map((session) => {
                    const active = session.key === snapshot.activeSessionKey;
                    return (
                        <span key={session.key} style={{ display: 'inline-flex', flex: 'none', alignItems: 'center' }}>
                            <button
                                id={`terminal-tab-${session.key}`}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                aria-controls={`terminal-panel-${session.key}`}
                                tabIndex={active ? 0 : -1}
                                onClick={() => controllerRef.current?.activateSession(session.key)}
                                onKeyDown={(event) => handleTabKeyDown(event, session.key)}
                                title={session.cwd}
                            >
                                {shellLabel(session.shell, session.ordinal)}
                            </button>
                            <button
                                type="button"
                                aria-label={`Close ${shellLabel(session.shell, session.ordinal)}`}
                                title="Close terminal session"
                                onClick={() => controllerRef.current?.closeSession(session.key)}
                            >
                                ×
                            </button>
                        </span>
                    );
                })}
                <button
                    type="button"
                    aria-label="New terminal session"
                    title="New terminal session"
                    disabled={snapshot.creating || snapshot.sessions.length >= MAX_TERMINAL_SESSIONS}
                    onClick={requestSession}
                >
                    +
                </button>
            </div>

            <div ref={viewportRef} style={{ position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
                {snapshot.sessions.map((session) => {
                    const active = session.key === snapshot.activeSessionKey;
                    return (
                        <div
                            key={session.key}
                            id={`terminal-panel-${session.key}`}
                            ref={(node) => controllerRef.current?.attachHost(session.key, node)}
                            role="tabpanel"
                            aria-labelledby={`terminal-tab-${session.key}`}
                            aria-hidden={!active}
                            inert={!active}
                            style={{ position: 'absolute', inset: 0, display: active ? 'block' : 'none' }}
                        />
                    );
                })}
                {snapshot.sessions.length === 0 ? (
                    <div role="status">
                        <button type="button" onClick={requestSession}>New terminal</button>
                    </div>
                ) : null}
            </div>

            <div
                role={snapshot.rejection || activeSession?.status === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                style={{ minHeight: 24 }}
            >
                {snapshot.rejection ?? activeSession?.message ?? 'No terminal sessions'}
                {activeSession && (activeSession.status === 'exited' || activeSession.status === 'error') ? (
                    <button type="button" onClick={() => controllerRef.current?.restartSession(activeSession.key)}>
                        Restart terminal
                    </button>
                ) : null}
            </div>
        </div>
    );
}
