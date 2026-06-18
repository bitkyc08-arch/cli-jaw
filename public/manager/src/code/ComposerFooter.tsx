import type { PermissionMode } from './code-types';

type ComposerFooterProps = {
    provider: string;
    providerOptions: string[];
    model: string;
    modelOptions: string[];
    effort: string;
    effortOptions: string[];
    permissionMode: PermissionMode;
    disabled: boolean;
    onProviderChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onEffortChange: (value: string) => void;
    onPermissionModeChange: (value: PermissionMode) => void;
};

const permissionDescriptions: Record<PermissionMode, string> = {
    ask: 'Prompt before gated tools',
    'always-allow': 'Select JWC allow_always',
    'always-deny': 'Select JWC reject_always',
};

export function ComposerFooter({
    provider, providerOptions,
    model, modelOptions,
    effort, effortOptions,
    permissionMode,
    disabled,
    onProviderChange, onModelChange, onEffortChange, onPermissionModeChange,
}: ComposerFooterProps) {
    return (
        <div className="code-composer-footer">
            <div className="code-composer-footer-left">
                <label className="code-footer-field">
                    <span className="code-footer-label">Permission</span>
                    <select
                        className="code-footer-select"
                        value={permissionMode}
                        onChange={e => onPermissionModeChange(e.target.value as PermissionMode)}
                        disabled={disabled}
                        aria-label="Permission mode"
                    >
                        <option value="ask">Ask</option>
                        <option value="always-allow">Always allow</option>
                        <option value="always-deny">Always deny</option>
                    </select>
                    <span className="code-footer-description">{permissionDescriptions[permissionMode]}</span>
                </label>
            </div>
            <div className="code-composer-footer-right">
                {providerOptions.length > 0 && (
                    <label className="code-footer-field">
                        <span className="code-footer-label">Provider</span>
                        <select
                            className="code-footer-select"
                            value={provider}
                            onChange={e => onProviderChange(e.target.value)}
                            disabled={disabled}
                            aria-label="Provider"
                        >
                            {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                    </label>
                )}
                <label className="code-footer-field code-footer-field-model">
                    <span className="code-footer-label">Model</span>
                    <select
                        className="code-footer-select"
                        value={model}
                        onChange={e => onModelChange(e.target.value)}
                        disabled={disabled}
                        aria-label="Model"
                    >
                        {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </label>
                {effortOptions.length > 0 && (
                    <label className="code-footer-field">
                        <span className="code-footer-label">Effort</span>
                        <select
                            className="code-footer-select"
                            value={effort}
                            onChange={e => onEffortChange(e.target.value)}
                            disabled={disabled}
                            aria-label="Effort"
                        >
                            {effortOptions.map(e => <option key={e} value={e}>{e}</option>)}
                        </select>
                    </label>
                )}
            </div>
        </div>
    );
}
