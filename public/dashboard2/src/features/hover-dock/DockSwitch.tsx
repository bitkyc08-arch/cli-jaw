// Shared switch primitive — d2 settings switch values (settings.css:34)
// with the SettingsPageShell ARIA contract (role="switch", aria-checked).
type DockSwitchProps = {
    checked: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
    ariaLabel: string;
};

export function DockSwitch({ checked, onChange, disabled, ariaLabel }: DockSwitchProps) {
    return (
        <button
            type="button"
            className={`dock-switch${checked ? ' is-on' : ''}`}
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => onChange(!checked)}
        >
            <span className="dock-switch-thumb" />
        </button>
    );
}
