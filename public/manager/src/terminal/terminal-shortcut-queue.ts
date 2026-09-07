// This bounds pending intent at each renderer owner, not live PTY sessions.
export const TERMINAL_REQUEST_LIMIT = 16;
export const TERMINAL_QUEUE_OVERFLOW = 'Too many pending terminal requests (limit 16). Extra requests were discarded.';
export const TERMINAL_REVEAL_CONTROL_ID = 'desktop-terminal-toggle';
export type PendingTerminalAction = 'focusTerminal' | 'newTerminalSession';
export type TerminalShortcutQueueWindow = Window & {
    __cliJawPendingTerminalActions?: PendingTerminalAction[];
    __cliJawPendingTerminalNotice?: string;
};

export function takeTerminalShortcutQueue(win: TerminalShortcutQueueWindow) {
    const actions = win.__cliJawPendingTerminalActions ?? [];
    const notice = win.__cliJawPendingTerminalNotice;
    // Transfer ownership before invoking a receiver: a later flush cannot replay.
    win.__cliJawPendingTerminalActions = [];
    delete win.__cliJawPendingTerminalNotice;
    return { actions, notice };
}

export function createTerminalShortcutQueue(win: TerminalShortcutQueueWindow) {
    let timer: number | undefined;
    return {
        enqueue(detail: PendingTerminalAction) {
            const actions = win.__cliJawPendingTerminalActions ?? [];
            if (detail === 'focusTerminal') {
                if (!actions.includes(detail)) actions.push(detail);
            } else if (actions.filter(action => action === 'newTerminalSession').length < TERMINAL_REQUEST_LIMIT) {
                actions.push(detail);
            } else {
                win.__cliJawPendingTerminalNotice = TERMINAL_QUEUE_OVERFLOW;
            }
            win.__cliJawPendingTerminalActions = actions;
            if (timer !== undefined) return;
            timer = win.setTimeout(() => {
                timer = undefined;
                win.document.dispatchEvent(new CustomEvent('jaw:shortcut-action', { detail: 'flushTerminalShortcutQueue' }));
            }, 0);
        },
        dispose() {
            if (timer !== undefined) win.clearTimeout(timer);
            timer = undefined;
            takeTerminalShortcutQueue(win);
        },
    };
}
