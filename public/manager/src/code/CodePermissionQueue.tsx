import type { PendingPermission } from './code-types';

type CodePermissionQueueProps = {
    permissions: PendingPermission[];
    onAnswer: (permissionId: string, optionId: string | null) => void;
};

export function CodePermissionQueue({ permissions, onAnswer }: CodePermissionQueueProps) {
    if (permissions.length === 0) return null;
    return (
        <div className="code-permissions">
            {permissions.map(p => (
                <div key={p.permissionId} className="code-permission-card">
                    <div className="code-permission-title">
                        Permission: {String(p.toolCall['toolName'] ?? p.toolCall['title'] ?? 'tool')}
                    </div>
                    <div className="code-permission-actions">
                        {p.options.length > 0 ? p.options.map((opt, i) => (
                            <button key={i} type="button" className="code-permission-btn"
                                onClick={() => onAnswer(p.permissionId, String(opt['optionId'] ?? opt['id'] ?? i))}
                            >{String(opt['name'] ?? opt['label'] ?? `Option ${i + 1}`)}</button>
                        )) : (
                            <>
                                <button type="button" className="code-permission-btn code-permission-allow"
                                    onClick={() => onAnswer(p.permissionId, 'allow')}
                                >Allow</button>
                                <button type="button" className="code-permission-btn code-permission-deny"
                                    onClick={() => onAnswer(p.permissionId, null)}
                                >Deny</button>
                            </>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
