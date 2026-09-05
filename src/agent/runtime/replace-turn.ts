import type { AcpRuntimeSession } from './acp/runtime-session.js';

/** Main-private receipt: dispatched means a local write, not remote acceptance. */
export type MainReplacementResult =
    | { kind: 'dispatched' }
    | { kind: 'cancelled' }
    | { kind: 'unavailable' | 'race'; reason: string }
    | { kind: 'failed'; error: Error };

/** Fixed diagnostic: never include either conversation's private binding values. */
export class MainReplacementOwnerMismatchError extends Error {
    readonly code = 'native_replacement_owner_mismatch';
    constructor() {
        super('native_replacement_owner_mismatch');
        this.name = 'MainReplacementOwnerMismatchError';
    }
}

export async function replaceAcpMainTurn(
    facade: AcpRuntimeSession | null,
    text: string,
    onLocalDispatch: () => void,
): Promise<MainReplacementResult> {
    if (!facade) return { kind: 'unavailable', reason: 'native-turn-not-started' };
    let attempted = false;
    try {
        const receipt = await facade.steer({ text }, () => {
            if (attempted) throw new Error('native_replacement_duplicate_dispatch');
            attempted = true;
            return onLocalDispatch();
        });
        if (receipt.accepted !== attempted) throw new Error('native_replacement_inconsistent_receipt');
        if (receipt.accepted) return { kind: 'dispatched' };
        const reason = receipt.reason || 'not-started';
        if (reason === 'stopped') return { kind: 'cancelled' };
        return { kind: ['busy', 'superseded', 'not-current'].includes(reason) ? 'race' : 'unavailable', reason };
    } catch (cause) {
        const error = cause instanceof Error ? cause : new Error('native_replacement_failed', { cause });
        // Also fence malformed receipts: no caller may retry an indeterminate write.
        facade.protocol.retire(error);
        return { kind: 'failed', error };
    }
}
