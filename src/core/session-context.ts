import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionScope } from '../messaging/session-key.js';

const storage = new AsyncLocalStorage<SessionScope>();

export function currentSessionScope(): SessionScope | undefined { return storage.getStore(); }
export function withSessionScope<T>(scope: SessionScope, fn: () => T): T {
    return storage.run(scope, fn);
}
