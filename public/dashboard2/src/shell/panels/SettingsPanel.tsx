import type { JSX } from 'react';
import { usePreferences } from '../../providers/preferences-provider.tsx';

const THEME_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
] as const;

export function SettingsPanel(): JSX.Element {
    const { hydrated, locale, shortcuts, theme } = usePreferences();

    return (
        <section className="d2-settings-panel" aria-labelledby="d2-settings-title">
            <h2 id="d2-settings-title">Settings</h2>

            <form className="d2-settings-form">
                <div className="d2-settings-row">
                    <span className="d2-settings-label">Theme</span>
                    <div className="d2-settings-segmented" role="group" aria-label="Theme">
                        {THEME_OPTIONS.map((option) => (
                            <button
                                className={theme.mode === option.value ? 'is-active' : undefined}
                                type="button"
                                key={option.value}
                                disabled={!hydrated}
                                aria-pressed={theme.mode === option.value}
                                onClick={() => theme.setMode(option.value)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>

                <label className="d2-settings-row">
                    <span className="d2-settings-label">Keyboard shortcuts</span>
                    <input
                        className="d2-settings-toggle"
                        type="checkbox"
                        role="switch"
                        disabled={!hydrated}
                        checked={shortcuts.shortcutsEnabled}
                        onChange={(event) => shortcuts.setShortcutsEnabled(event.currentTarget.checked)}
                    />
                </label>

                <label className="d2-settings-row">
                    <span className="d2-settings-label">Locale</span>
                    <select
                        className="d2-settings-select"
                        disabled={!hydrated}
                        value={locale.locale}
                        onChange={(event) => locale.setLocale(event.currentTarget.value as 'ko' | 'en')}
                    >
                        <option value="ko">Korean</option>
                        <option value="en">English</option>
                    </select>
                </label>
            </form>
        </section>
    );
}
