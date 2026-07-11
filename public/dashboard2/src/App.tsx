// Contract: consume src/shared/chat-events.ts as type-only imports.
import type { JSX } from 'react';
import type { TurnSegment } from '../../../src/shared/chat-events.ts';
import { Shell } from './shell/Shell.tsx';

// Compile-time proof that the shared turn-segment contract is reachable
// type-only from this entry (no runtime duplicate contract).
type BootstrapContractProbe = Pick<TurnSegment, 'turnId' | 'turnSeq' | 'segmentId'>;

export function App(): JSX.Element {
    const probe: BootstrapContractProbe | null = null;
    void probe;
    return <Shell />;
}
