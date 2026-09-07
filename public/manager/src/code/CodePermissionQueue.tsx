import { useRef, useState } from 'react';
import type { CodePermissionRequest, CodeSessionInfo } from '../../../../src/code-mode/wire';
import type { CodeControllerModel } from './code-controller-types';
import { CODE_RUNTIME_LABELS } from './code-types';

type Props = {
    permissions: CodePermissionRequest[];
    operations: CodeControllerModel['permissionOperations'];
    session: CodeSessionInfo | null;
    synced: boolean;
    onAnswer: CodeControllerModel['answer'];
};
function PermissionCard({ permission: p, operation, eligible, onAnswer }: {
    permission: CodePermissionRequest;
    operation: CodeControllerModel['permissionOperations'][string] | undefined;
    eligible: boolean;
    onAnswer: Props['onAnswer'];
}) {
    const inFlight = useRef(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function answer(optionId: string) {
        if (!eligible || inFlight.current || operation?.pending) return;
        inFlight.current = true; setPending(true); setError(null);
        try { await onAnswer(p, optionId); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { inFlight.current = false; setPending(false); }
    }
    return <section className="code-permission-card" aria-label={p.title}>
        <div className="code-permission-title"><strong>{p.title}</strong><p>{p.detail}</p>
            {!eligible && <small>Updating permission availability…</small>}
            {(pending || operation?.pending) && <small role="status">Checking decision…</small>}
            {(operation?.error || error) && <div className="code-action-error" role="alert">{operation?.error || error}</div>}
        </div>
        <div className="code-permission-actions">
            {p.options.map(option => <button key={option.optionId} type="button" className="code-permission-btn"
                disabled={!eligible || pending || operation?.pending} onClick={() => void answer(option.optionId)}>{option.label}</button>)}
            {p.options.length === 0 && <span>No native actions available. Refresh this session.</span>}
        </div>
    </section>;
}
export function CodePermissionQueue({ permissions, operations, session, synced, onAnswer }: Props) {
    if (!permissions.length) return null;
    return <aside className="code-permissions" aria-label="Pending permissions" tabIndex={-1} id="code-pending-permissions">
        <div className="code-permissions-heading" role="status">{permissions.length} pending · {session ? CODE_RUNTIME_LABELS[session.provider] : 'Session updating'}</div>
        {permissions.map(p => <PermissionCard key={`${p.sessionId}:${p.permissionId}`} permission={p} operation={operations[p.permissionId]}
            eligible={synced && session !== null && session.archivedAt === null && session.sessionId === p.sessionId
                && session.turnId === p.turnId && session.epoch === p.epoch
                && (session.status === 'starting' || session.status === 'streaming')} onAnswer={onAnswer} />)}
    </aside>;
}
