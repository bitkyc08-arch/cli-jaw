import { useEffect, type ReactNode } from 'react';
import type { DashboardRegistryUi } from '../types';
import type { DashboardActivityTitleSupport } from './activity-title-support';

type DashboardSettingsWorkspaceProps = {
    activeSection: 'display' | 'activity';
    ui: DashboardRegistryUi;
    titleSupport: DashboardActivityTitleSupport;
    onUiPatch: (patch: Partial<DashboardRegistryUi>) => void;
};

const LOCALE_OPTIONS = [
    { value: 'ko', label: '한국어 (ko)' },
    { value: 'en', label: 'English (en)' },
] as const;

type DashboardLocale = typeof LOCALE_OPTIONS[number]['value'];

function normalizeDashboardLocale(input: unknown): DashboardLocale {
    const match = LOCALE_OPTIONS.find(option => option.value === input);
    return match?.value ?? 'ko';
}

type DashboardSettingRowProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    children: ReactNode;
};

function DashboardSettingRow(props: DashboardSettingRowProps) {
    return (
        <div className="dashboard-settings-row">
            <div className="dashboard-settings-row-main">
                <label className="dashboard-settings-row-heading" htmlFor={props.id}>
                    <span>{props.label}</span>
                    <span className="dashboard-settings-row-scope">{props.scope}</span>
                </label>
                <p className="dashboard-settings-row-description">{props.description}</p>
            </div>
            <div className="dashboard-settings-row-control">
                {props.children}
            </div>
        </div>
    );
}

type DashboardSettingToggleProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    value: boolean;
    onChange: (value: boolean) => void;
};

function DashboardSettingToggle(props: DashboardSettingToggleProps) {
    return (
        <DashboardSettingRow id={props.id} label={props.label} scope={props.scope} description={props.description}>
            <input
                id={props.id}
                className="dashboard-settings-toggle"
                type="checkbox"
                checked={props.value}
                onChange={(event) => props.onChange(event.currentTarget.checked)}
            />
        </DashboardSettingRow>
    );
}

type DashboardSettingSelectProps = {
    id: string;
    label: string;
    scope: string;
    description: string;
    value: DashboardLocale;
    options: readonly { value: DashboardLocale; label: string }[];
    onChange: (value: DashboardLocale) => void;
};

function DashboardSettingSelect(props: DashboardSettingSelectProps) {
    return (
        <DashboardSettingRow id={props.id} label={props.label} scope={props.scope} description={props.description}>
            <select
                id={props.id}
                className="dashboard-settings-select"
                value={props.value}
                onChange={(event) => props.onChange(normalizeDashboardLocale(event.currentTarget.value))}
            >
                {props.options.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </DashboardSettingRow>
    );
}

function TitleSupportSummary({ support }: { support: DashboardActivityTitleSupport }) {
    const total = support.ready + support.legacy + support.offline;
    return (
        <div className="dashboard-settings-status-grid" aria-label="Activity title source readiness">
            <div>
                <span>Ready</span>
                <strong>{support.ready}</strong>
            </div>
            <div>
                <span>Legacy endpoint</span>
                <strong>{support.legacy}</strong>
            </div>
            <div>
                <span>Offline</span>
                <strong>{support.offline}</strong>
            </div>
            <p>{total === 0 ? 'No instances are currently visible.' : 'Restart legacy instances to enable latest activity titles.'}</p>
        </div>
    );
}

export function DashboardSettingsWorkspace(props: DashboardSettingsWorkspaceProps) {
    useEffect(() => {
        document.documentElement.lang = props.ui.locale;
    }, [props.ui.locale]);

    return (
        <main className="dashboard-settings-workspace" aria-label="Dashboard settings">
            <header className="dashboard-settings-header">
                <span className="eyebrow">Manager preferences</span>
                <h2>Dashboard settings</h2>
            </header>
            {props.activeSection === 'display' ? (
                <section className="dashboard-settings-section">
                    <header>
                        <h3>Instance list display</h3>
                        <p>These controls only affect the left instance list and saved manager UI preferences.</p>
                    </header>
                    <div className="dashboard-settings-field-list">
                        <DashboardSettingToggle
                            id="dashboard-show-activity-title"
                            label="Recent activity preview"
                            scope="Left instance list"
                            value={props.ui.showLatestActivityTitles}
                            description="Show one cleaned line from the latest user or assistant message when the instance supports the summary endpoint."
                            onChange={(next) => props.onUiPatch({ showLatestActivityTitles: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-label-editor"
                            label="Rename control"
                            scope="Left instance list"
                            value={props.ui.showInlineLabelEditor}
                            description="Show the pencil button for editing the dashboard-only instance label."
                            onChange={(next) => props.onUiPatch({ showInlineLabelEditor: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-runtime-line"
                            label="Runtime line"
                            scope="Left instance list"
                            value={props.ui.showSidebarRuntimeLine}
                            description="Show CLI and model text, for example codex / gpt-5.5, under each instance label."
                            onChange={(next) => props.onUiPatch({ showSidebarRuntimeLine: next })}
                        />
                        <DashboardSettingToggle
                            id="dashboard-show-row-actions"
                            label="Expanded row actions"
                            scope="Selected instance row"
                            value={props.ui.showSelectedRowActions}
                            description="Show Preview, Open, Start, Stop, and Restart buttons on the selected instance row."
                            onChange={(next) => props.onUiPatch({ showSelectedRowActions: next })}
                        />
                        <DashboardSettingSelect
                            id="dashboard-locale"
                            label="Language"
                            scope="Global Jaw UI"
                            value={normalizeDashboardLocale(props.ui.locale)}
                            options={LOCALE_OPTIONS}
                            description="Sets the saved manager dashboard locale for i18n-aware surfaces."
                            onChange={(next) => props.onUiPatch({ locale: next })}
                        />
                    </div>
                </section>
            ) : (
                <section className="dashboard-settings-section">
                    <header>
                        <h3>Preview & activity</h3>
                        <p>Latest activity titles depend on each instance server endpoint version.</p>
                    </header>
                    <TitleSupportSummary support={props.titleSupport} />
                </section>
            )}
        </main>
    );
}
