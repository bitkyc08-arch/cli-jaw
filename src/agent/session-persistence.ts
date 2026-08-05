import { settings } from '../core/config.js';
import { db, updateSession, upsertSessionBucket } from '../core/db.js';
import { resolveSessionBucket } from './args.js';
import { currentSessionScope } from '../core/session-context.js';

export type SessionOwnerToken = { global: number; scope: number };

export type SessionPersistenceInput = {
    persistenceOwner: SessionOwnerToken;
    scopeKey: string;
    forceNew?: boolean;
    employeeSessionId?: string | null;
    sessionId?: string | null;
    isFallback?: boolean;
    code?: number | null;
    wasKilled?: boolean;
    skipSessionPersist?: boolean;
    cli: string;
    model: string;
    provider?: string | null | undefined;
    resumeKey?: string | null;
    effort: string;
    permissions?: string;
    workingDir?: string;
    outputLen?: number | undefined;
    codexAppBucket?: string | undefined;
    // The bucket the run actually used, already keyed by scope (073 §2.1).
    scopedBucket?: string | undefined;
};

let globalGeneration = 0;
const scopeGenerations = new Map<string, number>();

export function getSessionOwnershipGeneration(scopeKey: string): SessionOwnerToken {
    return {
        global: globalGeneration,
        scope: scopeGenerations.get(scopeKey) ?? 0,
    };
}

export function bumpSessionOwnershipGeneration(): number {
    globalGeneration += 1;
    return globalGeneration;
}

export function bumpScopeSessionGeneration(scopeKey: string): number {
    const nextGeneration = (scopeGenerations.get(scopeKey) ?? 0) + 1;
    scopeGenerations.set(scopeKey, nextGeneration);
    return nextGeneration;
}

// Clearing or resetting ONE session must invalidate only that session's in-flight run.
// The global bump is for changes that genuinely affect every run — a settings change
// that alters how any of them would behave. Using it for a session-local reset made a
// second session's turn fail its ownership check on the way out and silently discard
// the conversation it had just created (073 §2.2).
export function bumpGenerationForSessionLocalReset(): number {
    const scope = currentSessionScope()?.scope;
    return scope ? bumpScopeSessionGeneration(scope) : bumpSessionOwnershipGeneration();
}

export function resetSessionOwnershipGenerationForTest(): void {
    globalGeneration = 0;
    scopeGenerations.clear();
}

export function isCurrentSessionOwner(token: SessionOwnerToken, scopeKey: string): boolean {
    return token.global === globalGeneration
        && token.scope === (scopeGenerations.get(scopeKey) ?? 0);
}

export function shouldPersistMainSession(input: SessionPersistenceInput): boolean {
    if (input.skipSessionPersist) return false;
    if (input.forceNew || input.employeeSessionId || !input.sessionId || input.isFallback) return false;
    if (input.cli === 'ai-e' && input.provider !== 'claude' && input.provider !== 'kiro' && input.provider !== 'codex' && input.provider !== 'grok') return false;
    // User-initiated kill (SIGTERM/SIGKILL) yields exit codes like 143/137/1 depending on
    // the CLI's signal handler. Allow persistence when wasKilled=true so resume works for
    // CLIs (claude, copilot) that don't translate SIGTERM to exit 0.
    // claude-e and ai-e's Claude PTY provider use exit code 2 for graceful SIGINT interrupt.
    const isGracefulInterrupt = input.code === 2
        && (input.cli === 'claude-e' || (input.cli === 'ai-e' && (input.provider === 'claude' || input.provider === 'codex' || input.provider === 'grok')));
    if (
        input.code !== undefined && input.code !== null && input.code !== 0
        && !input.wasKilled && !isGracefulInterrupt
    ) return false;
    return isCurrentSessionOwner(input.persistenceOwner, input.scopeKey);
}

export function persistMainSession(input: SessionPersistenceInput): boolean {
    const codexAppBucket = input.codexAppBucket;
    if (
        codexAppBucket !== undefined
        && (
            typeof codexAppBucket !== 'string'
            || !codexAppBucket.startsWith('codex-app:')
            || codexAppBucket.slice('codex-app:'.length).trim().length === 0
        )
    ) {
        console.warn('[jaw:session] rejected invalid codexAppBucket before persistence');
        return false;
    }
    if (!shouldPersistMainSession(input)) return false;
    // Mirror into per-bucket table so codex-spark keeps a session independent from
    // plain codex (gpt-5.4 etc.) — avoids 'thread/resume failed: no rollout found'
    // on cross-model toggles. Both writes go together: a singleton row pointing at
    // a thread the bucket never recorded sends the next resume to the wrong place.
    const bucket = input.scopedBucket
        ?? codexAppBucket
        ?? resolveSessionBucket(input.cli, input.model, input.provider);
    // The bucket is per scope now, but the singleton `session` row is still one row for
    // the instance. Only the default scope owns it; a second session writing there would
    // point the next default resume at a thread that belongs to someone else (073 §2.1).
    const ownsSingletonRow = (input.scopeKey || 'default') === 'default';
    db.transaction(() => {
        if (ownsSingletonRow) {
            updateSession.run(
                input.cli,
                input.sessionId,
                input.model,
                input.permissions || settings["permissions"] || 'auto',
                input.workingDir || settings["workingDir"] || '~',
                input.effort,
            );
        }
        if (bucket && input.sessionId) {
            upsertSessionBucket.run(bucket, input.sessionId, input.model, input.resumeKey || null, input.outputLen ?? 0);
        }
    })();
    return true;
}
