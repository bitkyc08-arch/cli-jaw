import type { ReactNode } from 'react';
import type { DashboardDetailTab } from '../types';

type WorkbenchProps = {
    mode: DashboardDetailTab;
    onModeChange: (mode: DashboardDetailTab) => void;
    header: ReactNode;
    overview: ReactNode;
    preview: ReactNode;
    logs: ReactNode;
    settings: ReactNode;
};

const MODES: DashboardDetailTab[] = ['overview', 'preview', 'logs', 'settings'];

function modeLabel(mode: DashboardDetailTab): string {
    return mode[0].toUpperCase() + mode.slice(1);
}

export function Workbench(props: WorkbenchProps) {
    return (
        <section className={`workbench workbench-${props.mode}`} aria-label="Selected instance workbench">
            <div className="workbench-header">
                {props.header}
                <div className="workbench-mode-tabs" role="tablist" aria-label="Workbench modes">
                    {MODES.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            role="tab"
                            aria-selected={props.mode === mode}
                            className={props.mode === mode ? 'is-active' : ''}
                            onClick={() => props.onModeChange(mode)}
                        >
                            {modeLabel(mode)}
                        </button>
                    ))}
                </div>
            </div>
            <div className="workbench-body">
                {props.mode === 'overview' && (
                    <div key="overview" className="workbench-panel workbench-panel-overview">{props.overview}</div>
                )}
                <div
                    key="preview"
                    className="workbench-panel workbench-panel-preview"
                    hidden={props.mode !== 'preview'}
                    aria-hidden={props.mode !== 'preview'}
                    data-preview-host="persistent"
                >
                    {props.preview}
                </div>
                {props.mode === 'logs' && (
                    <div key="logs" className="workbench-panel workbench-panel-logs">{props.logs}</div>
                )}
                {props.mode === 'settings' && (
                    <div key="settings" className="workbench-panel workbench-panel-settings">{props.settings}</div>
                )}
            </div>
        </section>
    );
}
