export interface TerminalRequestLedger {
    issued: number;
    consumed: number;
}

export const initialTerminalRequestLedger: TerminalRequestLedger = { issued: 0, consumed: 0 };

export type TerminalRequestLedgerAction =
    | { type: 'issue' }
    | { type: 'consume-through'; token: number };

export function terminalRequestLedgerReducer(
    state: TerminalRequestLedger,
    action: TerminalRequestLedgerAction,
): TerminalRequestLedger {
    if (action.type === 'issue') return { ...state, issued: state.issued + 1 };
    const consumed = Math.max(state.consumed, Math.min(action.token, state.issued));
    return consumed === state.consumed ? state : { ...state, consumed };
}
