// dashboard2 bootstrap shell (030). The real shell/providers land in 031/032.
// Contract: consume src/shared/chat-events.ts as type-only imports.
import type { JSX } from 'react';
import type { TurnSegment } from '../../../src/shared/chat-events.ts';

// Compile-time proof that the shared turn-segment contract is reachable
// type-only from this entry (no runtime duplicate contract).
type BootstrapContractProbe = Pick<TurnSegment, 'turnId' | 'turnSeq' | 'segmentId'>;

export function App(): JSX.Element {
    const probe: BootstrapContractProbe | null = null;
    void probe;
    return (
        <div className="d2-bootstrap">
            <h1>dashboard2</h1>
            <p>Bootstrap entry (030). Shell arrives in 031.</p>
        </div>
    );
}
