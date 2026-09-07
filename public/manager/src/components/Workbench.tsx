import { useEffect, useRef, type ReactNode } from 'react';
import type { DashboardDetailTab } from '../types';

type WorkbenchProps = {
    mode: DashboardDetailTab;
    onModeChange: (mode: DashboardDetailTab) => void;
    header: ReactNode;
    modeActions?: ReactNode;
    overview: ReactNode;
    preview: ReactNode;
    logs: ReactNode;
    settings: ReactNode;
    settingsOpen: boolean;
    onSettingsClose: () => void;
    active: boolean;
};

const MODES: DashboardDetailTab[] = ['overview', 'preview', 'logs'];

function modeLabel(mode: DashboardDetailTab): string {
    return mode[0].toUpperCase() + mode.slice(1);
}

export function Workbench(props: WorkbenchProps) {
    const panelRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (!props.settingsOpen || !props.active) return;
        const panel = panelRef.current;
        const previous = document.activeElement;
        panel?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
        return () => {
            if (document.activeElement !== document.body && !panel?.contains(document.activeElement)) return;
            const target = previous instanceof HTMLElement && previous.isConnected && previous.getClientRects().length
                ? previous : document.querySelector<HTMLElement>('.workbench-settings-toggle');
            if (target?.getClientRects().length) target.focus({ preventScroll: true });
        };
    }, [props.settingsOpen, props.active]);
    return (
        <section className={`workbench workbench-${props.mode}`} data-instance-settings-open={props.settingsOpen} aria-label="Selected instance workbench">
            <div className="workbench-header">
                {props.header}
                <div className="workbench-mode-bar">
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
                    {props.modeActions}
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
            </div>
            {props.settingsOpen && (
                <aside ref={panelRef} id="workbench-instance-settings" className="workbench-settings-panel"
                    aria-label="Instance settings" onKeyDown={(event) => {
                        if (event.key !== 'Escape' || event.defaultPrevented) return;
                        if ((event.target as Element).closest('[role="dialog"], [role="listbox"]')) return;
                        event.preventDefault(); event.stopPropagation(); props.onSettingsClose();
                    }}>
                    <header><strong>Instance settings</strong><button type="button" aria-label="Close instance settings" onClick={props.onSettingsClose}>Close</button></header>
                    {props.settings}
                </aside>
            )}
        </section>
    );
}
