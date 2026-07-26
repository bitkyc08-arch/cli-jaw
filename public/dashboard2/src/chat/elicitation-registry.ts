/**
 * ChatView-scoped registry for elicitation completion (CF-2).
 *
 * An elicitation's completion (answers + status) used to live in the fence's
 * component-local useState/useRef, which virtualization unmounts and loses —
 * so scrolling a completed elicitation out and back revived it as active,
 * allowing a duplicate submission. The registry hoists completion to the
 * ChatView lifetime, keyed by the stable identity of the elicitation's slot.
 *
 * The key is `scopeKey/turnId/segmentId/slot.id`, so the SAME elicitation
 * remounting after virtualization hydrates its completion instead of
 * restarting.
 */
import type { ElicitationAnswer } from '../turn-stream/render/fences/ElicitationFence.tsx';

export interface ElicitationCompletion {
    answers: ElicitationAnswer[];
}

const registry = new Map<string, ElicitationCompletion>();

export function elicitationKey(identity: {
    scopeKey: string;
    turnId: string | number;
    segmentId: string | number;
    slotId: string;
}): string {
    return `${identity.scopeKey}/${identity.turnId}/${identity.segmentId}/${identity.slotId}`;
}

export function getElicitationCompletion(key: string): ElicitationCompletion | null {
    return registry.get(key) ?? null;
}

export function setElicitationCompletion(key: string, completion: ElicitationCompletion): void {
    registry.set(key, completion);
}

/** Test seam: drop all completions. */
export function resetElicitationRegistry(): void {
    registry.clear();
}
