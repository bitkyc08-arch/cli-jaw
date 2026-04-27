import type { DashboardUiTheme } from '../types';

type ThemeSwitchProps = {
    theme: DashboardUiTheme;
    onChange: (next: DashboardUiTheme) => void;
};

const OPTIONS: ReadonlyArray<{ value: DashboardUiTheme; label: string; hint: string }> = [
    { value: 'auto', label: 'Auto', hint: 'Follow OS preference' },
    { value: 'light', label: 'Light', hint: 'Always light theme' },
    { value: 'dark', label: 'Dark', hint: 'Always dark theme' },
];

export function ThemeSwitch(props: ThemeSwitchProps) {
    return (
        <div className="theme-switch" role="radiogroup" aria-label="Theme">
            {OPTIONS.map(option => {
                const active = props.theme === option.value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={option.hint}
                        className={active ? 'is-active' : ''}
                        onClick={() => props.onChange(option.value)}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
