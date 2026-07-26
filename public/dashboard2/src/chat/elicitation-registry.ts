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

/**
 * One registry per ChatView scope, not a module singleton. Each ChatView's
 * completions live in their own map, so two ChatViews never share state, and
 * a session switch disposes its own map rather than clearing a global one.
 */
const REGISTRY_CAP = 500;
const registries = new Map<string, Map<string, ElicitationCompletion>>();

function scopeRegistry(scopeKey: string): Map<string, ElicitationCompletion> {
    let registry = registries.get(scopeKey);
    if (!registry) {
        registry = new Map();
        registries.set(scopeKey, registry);
    }
    return registry;
}

/** Bind the registry to a ChatView's scope; clears when the scope changes. */
export function bindElicitationRegistry(scopeKey: string): void {
    // Eagerly create the scope's map; a ChatView switch disposes via
    // disposeElicitationRegistry on unmount, not by clearing a global.
    scopeRegistry(scopeKey);
}

/** Dispose a ChatView's completions on unmount/session switch. */
export function disposeElicitationRegistry(scopeKey: string): void {
    registries.delete(scopeKey);
}

export function elicitationKey(identity: {
    scopeKey: string;
    turnId: string | number;
    segmentId: string | number;
    slotId: string;
}): string {
    return `${identity.scopeKey}/${identity.turnId}/${identity.segmentId}/${identity.slotId}`;
}

export function getElicitationCompletion(scopeKey: string, key: string): ElicitationCompletion | null {
    // The scope is passed explicitly, never parsed out of the key: a scopeKey
    // itself contains '/', so key.split('/') cannot recover it.
    return registries.get(scopeKey)?.get(key) ?? null;
}

export function setElicitationCompletion(scopeKey: string, key: string, completion: ElicitationCompletion): void {
    const registry = scopeRegistry(scopeKey);
    if (registry.size >= REGISTRY_CAP && !registry.has(key)) {
        const oldest = registry.keys().next().value;
        if (oldest !== undefined) registry.delete(oldest);
    }
    registry.set(key, completion);
}

/** Test seam: drop all completions. */
export function resetElicitationRegistry(): void {
    registries.clear();
}
