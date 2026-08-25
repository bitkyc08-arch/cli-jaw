import { currentSessionScope } from '../core/session-context.js';

/** The session a slash-command turn belongs to, in submitMessage's shape.
 *
 *  A slash handler runs inside the request's AsyncLocalStorage scope, but it used
 *  to forward only `origin`. The message then landed in the tab's chat session
 *  while the queue and PABCD scope resolved to 'default' — the turn waited behind
 *  unrelated work and ran outside its own lane. Empty when multi-session is off,
 *  which is exactly when 'default' is the right answer anyway. */
export function sessionScopeMeta(): { scope?: string; chatSessionId?: string } {
    const scope = currentSessionScope();
    if (!scope) return {};
    const meta: { scope?: string; chatSessionId?: string } = {};
    if (scope.scope) meta.scope = scope.scope;
    if (scope.chatSessionId) meta.chatSessionId = scope.chatSessionId;
    return meta;
}

