import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, type JSX } from 'react';
import { useDesktopBridge } from '../../providers/desktop-bridge-provider.tsx';

interface TerminalPanelProps {
    port: number | null;
}

export function TerminalPanel({ port }: TerminalPanelProps): JSX.Element {
    const bridge = useDesktopBridge();
    const containerRef = useRef<HTMLDivElement>(null);
    const nativeTerminal = bridge.terminal.nativeAvailable ? bridge.terminal.native : null;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

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

        let disposed = false;
        let sessionId: string | null = null;
        const pendingOutput = new Map<string, string>();
        const fit = (): void => {
            if (container.isConnected && container.clientWidth > 0 && container.clientHeight > 0) {
                fitAddon.fit();
                if (nativeTerminal && sessionId) {
                    void nativeTerminal.resize(sessionId, terminal.cols, terminal.rows);
                }
            }
        };
        const frame = requestAnimationFrame(fit);
        const resizeObserver = new ResizeObserver(fit);
        resizeObserver.observe(container);

        terminal.writeln('\x1b[1;36mcli-jaw terminal\x1b[0m');
        let unsubscribeData: (() => void) | null = null;
        let inputDisposable: { dispose(): void };

        if (nativeTerminal && port !== null) {
            terminal.writeln(`Instance ${port}. Starting native terminal...`);
            unsubscribeData = nativeTerminal.onData((id, data) => {
                if (id === sessionId) {
                    terminal.write(data);
                } else if (sessionId === null) {
                    pendingOutput.set(id, `${pendingOutput.get(id) ?? ''}${data}`);
                }
            });
            inputDisposable = terminal.onData((data) => {
                if (sessionId) void nativeTerminal.write(sessionId, data);
            });

            void nativeTerminal.create({ cols: terminal.cols, rows: terminal.rows }).then((result) => {
                if (!result.ok || !result.id) {
                    throw new Error(result.error ?? 'Unable to create native terminal');
                }
                if (disposed) {
                    void nativeTerminal.kill(result.id);
                    return;
                }
                sessionId = result.id;
                const buffered = pendingOutput.get(result.id);
                if (buffered) terminal.write(buffered);
                pendingOutput.clear();
                void nativeTerminal.resize(result.id, terminal.cols, terminal.rows);
                terminal.focus();
            }).catch((error: unknown) => {
                if (!disposed) {
                    const message = error instanceof Error ? error.message : 'Unable to create native terminal';
                    terminal.writeln(`\r\n${message}`);
                }
            });
        } else {
            terminal.writeln(port === null
                ? 'No instance selected. Local echo mode is active.'
                : `Instance ${port}. Local echo mode is active.`);
            terminal.write('\r\n$ ');
            inputDisposable = terminal.onData((data) => {
                for (const character of data) {
                    if (character === '\r') {
                        terminal.write('\r\n$ ');
                    } else if (character === '\x7f') {
                        if (terminal.buffer.active.cursorX > 2) terminal.write('\b \b');
                    } else if (character >= ' ' || character === '\t') {
                        terminal.write(character);
                    }
                }
            });
        }

        terminal.focus();

        return () => {
            disposed = true;
            cancelAnimationFrame(frame);
            resizeObserver.disconnect();
            unsubscribeData?.();
            inputDisposable.dispose();
            if (nativeTerminal && sessionId) void nativeTerminal.kill(sessionId);
            terminal.dispose();
        };
    }, [nativeTerminal, port]);

    return (
        <div
            ref={containerRef}
            className="d2-terminal-panel"
            aria-label={port === null ? 'Terminal' : `Terminal for instance ${port}`}
        />
    );
}
