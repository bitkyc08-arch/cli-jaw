import type { CodeSessionInfo } from '../../../../src/code-mode/types.ts';
import type { CodeApiClient } from './code-api-client.ts';

export interface CodeSessionGenerationGuard {
    signal: AbortSignal;
    isCurrent(): boolean;
}

export function isCurrentCodeSessionGeneration(expected: number, current: number): boolean {
    return expected === current;
}

/**
 * A create request is intentionally allowed to resolve after a port change:
 * once POST has reached the old worker, aborting the response would hide the
 * created session id and make cleanup impossible. The generation guard keeps
 * it out of current UI state and closes it through its originating client.
 */
export async function createCodeSessionForGeneration(
    client: CodeApiClient,
    cwd: string,
    modelId: string,
    guard: CodeSessionGenerationGuard,
): Promise<CodeSessionInfo | null> {
    const session = await client.newSession(cwd, modelId);
    if (!guard.signal.aborted && guard.isCurrent()) return session;
    await client.closeSession(session.sessionId).catch((cleanupError: unknown) => {
        // Orphan risk: surface the failed cleanup instead of dropping it silently.
        console.warn('[code] stale session cleanup failed', session.sessionId, cleanupError);
    });
    return null;
}
