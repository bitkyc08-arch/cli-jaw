type ComposerFooterProps = {
    provider: string;
    providerOptions: string[];
    model: string;
    modelOptions: string[];
    effort: string;
    effortOptions: string[];
    permissionMode: string;
    disabled: boolean;
    onProviderChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onEffortChange: (value: string) => void;
    onPermissionModeChange: (value: string) => void;
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
                    <span className="code-footer-label">Permissions</span>
                    <select
                        className="code-footer-select"
                        value={permissionMode}
                        onChange={e => onPermissionModeChange(e.target.value)}
                        disabled={disabled}
                        aria-label="Permission mode"
                    >
                        <option value="ask">Ask</option>
                        <option value="auto">Auto</option>
                        <option value="always-allow">Always allow</option>
                        <option value="always-deny">Always deny</option>
                    </select>
                </label>
            </div>
            <div className="code-composer-footer-right">
                {providerOptions.length > 0 && (
                    <select
                        className="code-footer-select"
                        value={provider}
                        onChange={e => onProviderChange(e.target.value)}
                        disabled={disabled}
                        aria-label="Provider"
                    >
                        {providerOptions.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                )}
                <select
                    className="code-footer-select"
                    value={model}
                    onChange={e => onModelChange(e.target.value)}
                    disabled={disabled}
                    aria-label="Model"
                >
                    {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                {effortOptions.length > 0 && (
                    <select
                        className="code-footer-select"
                        value={effort}
                        onChange={e => onEffortChange(e.target.value)}
                        disabled={disabled}
                        aria-label="Effort"
                    >
                        {effortOptions.map(e => <option key={e} value={e}>{e}</option>)}
                    </select>
                )}
            </div>
        </div>
    );
}
