import { PERMISSION_MODE_OPTIONS, type PermissionMode } from './code-types';

type CodePermissionModePickerProps = {
    value: PermissionMode;
    disabled?: boolean;
    onChange: (value: PermissionMode) => void;
};

export function CodePermissionModePicker({ value, disabled, onChange }: CodePermissionModePickerProps) {
    const selected = PERMISSION_MODE_OPTIONS.find(option => option.value === value) ?? PERMISSION_MODE_OPTIONS[0];
    return (
        <div className="code-permission-mode-field">
            <div className="code-permission-mode-label">
                <span>Permission mode</span>
                <strong>Default: Always allow</strong>
            </div>
            <div className="code-permission-mode-list" role="listbox" aria-label="Permission mode">
                {PERMISSION_MODE_OPTIONS.map(option => (
                    <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={option.value === value}
                        disabled={disabled}
                        className={`code-permission-mode-option is-${option.tone}${option.value === value ? ' is-selected' : ''}`}
                        title={option.detail}
                        onClick={() => onChange(option.value)}
                    >
                        <span>
                            <strong>{option.label}</strong>
                            <small>{option.detail}</small>
                        </span>
                        {option.value === value && <em aria-hidden="true">✓</em>}
                    </button>
                ))}
            </div>
            <p className={`code-permission-mode-note is-${selected?.tone ?? 'ask'}`}>
                Automatic modes answer with JWC persistent options and write a transcript audit row.
            </p>
        </div>
    );
}
