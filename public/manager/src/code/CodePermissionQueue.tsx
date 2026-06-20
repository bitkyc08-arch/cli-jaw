import {
    getPermissionToolName,
    PERMISSION_ACTION_LABELS,
    PERMISSION_ACTION_ORDER,
    PERMISSION_ACTION_TONES,
    resolvePermissionOption,
    type PendingPermission,
    type PermissionOptionKind,
} from './code-types';

type CodePermissionQueueProps = {
    permissions: PendingPermission[];
    onAnswer: (permission: PendingPermission, action: PermissionOptionKind) => void;
};

export function CodePermissionQueue({ permissions, onAnswer }: CodePermissionQueueProps) {
    if (permissions.length === 0) return null;
    return (
        <div className="code-permissions">
            {permissions.map(p => (
                <div key={p.permissionId} className="code-permission-card">
                    <div className="code-permission-title">
                        <span>Permission request</span>
                        <strong>{getPermissionToolName(p.toolCall)}</strong>
                        <small>{p.options.length} JWC options</small>
                    </div>
                    <div className="code-permission-actions">
                        {PERMISSION_ACTION_ORDER.map(action => {
                            const option = resolvePermissionOption(p.options, action);
                            const tone = PERMISSION_ACTION_TONES[action];
                            return (
                                <button
                                    key={action}
                                    type="button"
                                    className={`code-permission-btn is-${tone}`}
                                    disabled={!option}
                                    title={option ? option.optionId : `${PERMISSION_ACTION_LABELS[action]} option was not provided by JWC`}
                                    onClick={() => onAnswer(p, action)}
                                >
                                    {option?.label ?? PERMISSION_ACTION_LABELS[action]}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}
