import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useDesktopBridge } from '../../providers/desktop-bridge-provider.tsx';

interface TerminalPanelProps {
    port: number | null;
    workingDir: string | null;
    workingDirError?: string | null;
}

type TerminalState =
    | { kind: 'starting'; message: string }
    | { kind: 'running'; message: string }
    | { kind: 'exited'; message: string }
    | { kind: 'error'; message: string };

export function TerminalPanel({ port, workingDir, workingDirError = null }: TerminalPanelProps): JSX.Element {
    const bridge = useDesktopBridge();
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const inputEnabledRef = useRef(false);
    const [restartGeneration, setRestartGeneration] = useState(0);
    const [state, setState] = useState<TerminalState | null>(null);
    const [shortcutNotice, setShortcutNotice] = useState<string | null>(null);
    const nativeTerminal = bridge.terminal.nativeAvailable ? bridge.terminal.native : null;

    const restartTerminal = useCallback(() => {
        setShortcutNotice(null);
        setRestartGeneration((generation) => generation + 1);
    }, []);

    useEffect(() => {
        const shortcuts = bridge.shell.shortcuts.nativeAvailable ? bridge.shell.shortcuts.native : null;
        if (!shortcuts) return;
        return shortcuts.onAction((action) => {
            if (action === 'terminalClear') {
                terminalRef.current?.clear();
                setShortcutNotice('Terminal cleared');
            } else if (action === 'terminalNewTab') {
                setShortcutNotice('New terminal tabs will be available in 089.12');
            }
        });
    }, [bridge.shell.shortcuts.native, bridge.shell.shortcuts.nativeAvailable]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !nativeTerminal || port === null || !workingDir) return;

        const terminal = new Terminal({
            convertEol: true,
            cursorBlink: true,
            fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, monospace',
            fontSize: 13,
            theme: {
                background: '#000000',
                foreground: '#d4d4d4',
                cursor: '#f5f5f5',
                selectionBackground: '#264f78',
            },
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);
        terminalRef.current = terminal;

        let disposed = false;
        const pendingOutput = new Map<string, string>();
        const fit = (): void => {
            if (container.isConnected && container.clientWidth > 0 && container.clientHeight > 0) {
                fitAddon.fit();
                if (sessionIdRef.current) {
                    void nativeTerminal.resize(sessionIdRef.current, terminal.cols, terminal.rows);
                }
            }
        };
        const frame = requestAnimationFrame(fit);
        const resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(container);

        terminal.writeln('\x1b[1;36mcli-jaw terminal\x1b[0m');
        terminal.writeln(`Instance ${port}. Starting in ${workingDir}...`);
        setState({ kind: 'starting', message: `Starting terminal in ${workingDir}` });
        inputEnabledRef.current = false;

        const unsubscribeData = nativeTerminal.onData((id, data) => {
            if (id === sessionIdRef.current) terminal.write(data);
            else if (sessionIdRef.current === null) pendingOutput.set(id, `${pendingOutput.get(id) ?? ''}${data}`);
        });
        const unsubscribeExit = nativeTerminal.onExit((id, code) => {
            if (id !== sessionIdRef.current) return;
            sessionIdRef.current = null;
            inputEnabledRef.current = false;
            const codeLabel = code === null ? 'unknown' : String(code);
            terminal.writeln(`\r\n[process exited with code ${codeLabel}]`);
            setState({ kind: 'exited', message: `Terminal exited with code ${codeLabel}` });
        });
        const inputDisposable = terminal.onData((data) => {
            const id = sessionIdRef.current;
            if (inputEnabledRef.current && id) void nativeTerminal.write(id, data);
        });

        void nativeTerminal.create({ cwd: workingDir, cols: terminal.cols, rows: terminal.rows }).then((result) => {
            if (!result.ok || !result.id) throw new Error(result.error ?? 'Unable to create native terminal');
            if (disposed) {
                void nativeTerminal.kill(result.id);
                return;
            }
            sessionIdRef.current = result.id;
            inputEnabledRef.current = true;
            const actualCwd = result.cwd ?? workingDir;
            const message = actualCwd === workingDir
                ? `Terminal running in ${actualCwd}`
                : `Terminal requested ${workingDir}; running in ${actualCwd}`;
            if (actualCwd !== workingDir) terminal.writeln(`\r\n[${message}]`);
            setState({ kind: 'running', message });
            const buffered = pendingOutput.get(result.id);
            if (buffered) terminal.write(buffered);
            pendingOutput.clear();
            void nativeTerminal.resize(result.id, terminal.cols, terminal.rows);
            terminal.focus();
        }).catch((error: unknown) => {
            if (disposed) return;
            inputEnabledRef.current = false;
            const message = error instanceof Error ? error.message : 'Unable to create native terminal';
            terminal.writeln(`\r\n${message}`);
            setState({ kind: 'error', message });
        });

        return () => {
            disposed = true;
            cancelAnimationFrame(frame);
            resizeObserver.disconnect();
            unsubscribeData();
            unsubscribeExit();
            inputDisposable.dispose();
            const id = sessionIdRef.current;
            sessionIdRef.current = null;
            inputEnabledRef.current = false;
            if (id) void nativeTerminal.kill(id);
            terminalRef.current = null;
            terminal.dispose();
        };
    }, [nativeTerminal, port, restartGeneration, workingDir]);

    if (!nativeTerminal) {
        return <div className="d2-terminal-panel" role="status">Terminal requires the cli-jaw Electron app</div>;
    }
    if (port === null) {
        return <div className="d2-terminal-panel" role="status">No instance selected</div>;
    }
    if (workingDirError) {
        return <div className="d2-terminal-panel" role="alert">{workingDirError}</div>;
    }
    if (!workingDir) {
        return <div className="d2-terminal-panel" role="status" aria-busy="true">Loading terminal working directory…</div>;
    }

    return (
        <div className="d2-terminal-panel" aria-label={`Terminal for instance ${port}`}>
            <div ref={containerRef} style={{ width: '100%', height: 'calc(100% - 28px)' }} />
            <div role={state?.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
                {shortcutNotice ?? state?.message}
                {(state?.kind === 'exited' || state?.kind === 'error') ? (
                    <button type="button" onClick={restartTerminal}>Restart terminal</button>
                ) : null}
            </div>
        </div>
    );
}
