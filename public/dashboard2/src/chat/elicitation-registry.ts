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
 * restarting. scopeKey is in the key, so two ChatViews cannot collide; the
 * map is bounded by eviction, not by ChatView unmount (a completion is small).
 */
import type { ElicitationAnswer } from '../turn-stream/render/fences/ElicitationFence.tsx';

export interface ElicitationCompletion {
    answers: ElicitationAnswer[];
}

// Bounded so a long session does not grow the registry without limit, and
// scoped: completions belong to one ChatView scope at a time, so a session
// switch clears them rather than letting one session's elicitations bleed
// into another ChatView with the same turnId/slot.id.
const REGISTRY_CAP = 500;
const registry = new Map<string, ElicitationCompletion>();
let activeScopeKey: string | null = null;

/** Bind the registry to a ChatView's scope; clears when the scope changes. */
export function bindElicitationRegistry(scopeKey: string): void {
    if (activeScopeKey !== null && activeScopeKey !== scopeKey) {
        registry.clear();
    }
    activeScopeKey = scopeKey;
}

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
    if (registry.size >= REGISTRY_CAP && !registry.has(key)) {
        const oldest = registry.keys().next().value;
        if (oldest !== undefined) registry.delete(oldest);
    }
    registry.set(key, completion);
}

/** Test seam: drop all completions. */
export function resetElicitationRegistry(): void {
    registry.clear();
}
