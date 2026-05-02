import type { DashboardUiTheme } from '../types';
import { DesktopLink } from '../desktop-link';
import { CommandCenter } from './CommandCenter';
import { ThemeSwitch } from './ThemeSwitch';

type CommandBarProps = {
    query: string;
    loading: boolean;
    theme: DashboardUiTheme;
    onQueryChange: (value: string) => void;
    onRefresh: () => void;
    onOpenDrawer: () => void;
    onThemeChange: (next: DashboardUiTheme) => void;
    onOpenPalette: () => void;
};

export function CommandBar(props: CommandBarProps) {
    return (
        <CommandCenter
            mobileMenuButton={(
                <button className="drawer-trigger" type="button" onClick={props.onOpenDrawer} aria-label="Open sidebar">
                    ☰
                </button>
            )}
            title={(
                <h1 className="manager-brand-heading" aria-label="CLI-JAW Dashboard">
                    <span className="manager-brand-wordmark">CLI-JAW</span>
                    <span className="manager-brand-dash">DASH</span>
                </h1>
            )}
            search={(
                <div className="search-input-wrapper">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input
                        value={props.query}
                        onChange={event => props.onQueryChange(event.target.value)}
                        placeholder="Search port, home, CLI, model"
                        aria-label="Search instances"
                    />
                </div>
            )}
            actions={(
                <div className="command-actions-group">
                    <DesktopLink />
                    <button
                        type="button"
                        className="command-palette-trigger"
                        onClick={props.onOpenPalette}
                        aria-label="Open command palette"
                        title="Open command palette (⌘K / Ctrl+K)"
                    >
                        <span aria-hidden="true">⌘K</span>
                    </button>
                    <ThemeSwitch theme={props.theme} onChange={props.onThemeChange} />
                    <button type="button" onClick={props.onRefresh} disabled={props.loading}>
                        {props.loading ? 'Scanning' : 'Refresh'}
                    </button>
                </div>
            )}
        />
    );
}
