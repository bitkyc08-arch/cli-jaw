// 044 — minimal per-scope host for the turn stream inside the Workbench
// pane array. Owns one TurnStore per (port, sessionId) scope and disposes it
// on scope change (042 §7: session-switch store lifecycle lives client-side).
// 045 extends this host with the live tail and composer mount.
import { useEffect, useMemo, type JSX } from 'react';
import type { SessionScope } from '../../state/scope.tsx';
import { createTurnStore } from '../store/turn-store.ts';
import { TurnStreamViewport } from './TurnStreamViewport.tsx';

export interface TurnStreamPaneProps {
    scope: SessionScope;
}

export function TurnStreamPane({ scope }: TurnStreamPaneProps): JSX.Element {
    const scopeKey = `${scope.port}/${scope.sessionId}`;
    const store = useMemo(
        () => createTurnStore(scopeKey, { sessionFilter: scope.sessionId || null }),
        [scopeKey, scope.sessionId],
    );
    useEffect(() => () => store.dispose(), [store]);
    return (
        <div className="d2-turn-pane" data-testid="turn-stream-pane">
            <TurnStreamViewport store={store} />
        </div>
    );
}
