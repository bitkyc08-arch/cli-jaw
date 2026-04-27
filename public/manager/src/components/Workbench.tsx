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
    const contentByMode: Record<DashboardDetailTab, ReactNode> = {
        overview: props.overview,
        preview: props.preview,
        logs: props.logs,
        settings: props.settings,
    };

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
            <div className="workbench-body">{contentByMode[props.mode]}</div>
        </section>
    );
}
