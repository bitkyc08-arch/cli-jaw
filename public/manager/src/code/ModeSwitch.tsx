type ModeSwitchProps = {
    codeMode: boolean;
    onChange: (codeMode: boolean) => void;
};

export function ModeSwitch({ codeMode, onChange }: ModeSwitchProps) {
    return (
        <div className="mode-switch" role="tablist" aria-label="Jaw / Code mode">
            <button
                type="button"
                role="tab"
                className={`mode-switch-tab ${!codeMode ? 'active' : ''}`}
                aria-selected={!codeMode}
                onClick={() => onChange(false)}
            >
                Jaw
            </button>
            <button
                type="button"
                role="tab"
                className={`mode-switch-tab ${codeMode ? 'active' : ''}`}
                aria-selected={codeMode}
                onClick={() => onChange(true)}
            >
                Code
            </button>
        </div>
    );
}
