export interface TerminalRequestCounter {
    issued: number;
    consumed: number;
}

export interface TerminalRequestLedger {
    newTab: TerminalRequestCounter;
    focus: TerminalRequestCounter;
}

export const initialTerminalRequestLedger: TerminalRequestLedger = {
    newTab: { issued: 0, consumed: 0 },
    focus: { issued: 0, consumed: 0 },
};

export type TerminalRequestLedgerAction =
    | { type: 'issue' }
    | { type: 'issue-new-tab' }
    | { type: 'issue-focus' }
    | { type: 'consume-through'; token: number }
    | { type: 'consume-new-tab-through'; token: number }
    | { type: 'consume-focus-through'; token: number };

function consumeThrough(counter: TerminalRequestCounter, token: number): TerminalRequestCounter {
    const consumed = Math.max(counter.consumed, Math.min(token, counter.issued));
    return consumed === counter.consumed ? counter : { ...counter, consumed };
}

function issue(counter: TerminalRequestCounter): TerminalRequestCounter {
    return { ...counter, issued: counter.issued + 1 };
}

export function terminalRequestLedgerReducer(
    state: TerminalRequestLedger,
    action: TerminalRequestLedgerAction,
): TerminalRequestLedger {
    switch (action.type) {
        // 'issue' / 'consume-through' are the pre-split new-tab aliases.
        case 'issue':
        case 'issue-new-tab':
            return { ...state, newTab: issue(state.newTab) };
        case 'issue-focus':
            return { ...state, focus: issue(state.focus) };
        case 'consume-through':
        case 'consume-new-tab-through':
            return { ...state, newTab: consumeThrough(state.newTab, action.token) };
        case 'consume-focus-through':
            return { ...state, focus: consumeThrough(state.focus, action.token) };
    }
}

export type TerminalShortcutIntent = 'focus' | 'new-tab';

export function normalizeTerminalShortcutAction(action: string): TerminalShortcutIntent | null {
    if (action === 'focusTerminal') return 'focus';
    if (action === 'newTerminalSession' || action === 'terminalNewTab') return 'new-tab';
    return null;
}

export interface TerminalShortcutPorts {
    openPanel(): void;
    issueNewTab(): void;
    issueFocus(): void;
}

export function dispatchTerminalShortcutIntent(
    intent: TerminalShortcutIntent,
    ports: TerminalShortcutPorts,
): void {
    ports.openPanel();
    if (intent === 'new-tab') ports.issueNewTab();
    else ports.issueFocus();
}
