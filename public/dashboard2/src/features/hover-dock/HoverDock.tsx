import { useHoverDock } from './useHoverDock';
import { DOCK_TAB_KINDS, DOCK_TAB_TITLES, type HoverDockProps } from './types';
import type { SettingsData } from './dock-settings';
import { useDockClient, useDockSnapshot, type DockClient, type DockSnapshotState } from './dock-client';
import { AgentsTab } from './AgentsTab';
import { SkillsTab } from './SkillsTab';
import { SettingsTab } from './SettingsTab';
import type { DockTabKind } from './types';

export type DockSettingsSnapshot = {
    state: DockSnapshotState<SettingsData>;
    refresh: () => Promise<void>;
    setData: (next: SettingsData) => void;
};

function DockTabContent(props: { client: DockClient; tab: DockTabKind; open: boolean; locale?: string | undefined }) {
    const snapshot = useDockSnapshot<SettingsData>(props.client, '/api/settings', [props.open]);
    const settingsSnapshot: DockSettingsSnapshot = {
        state: snapshot.state,
        refresh: snapshot.refresh,
        setData: snapshot.setData,
    };
    return (
        <>
            {props.tab === 'agents' && <AgentsTab client={props.client} active={props.open} snapshot={settingsSnapshot} />}
            {props.tab === 'skills' && <SkillsTab client={props.client} active={props.open} locale={props.locale} />}
            {props.tab === 'settings' && <SettingsTab client={props.client} active={props.open} snapshot={settingsSnapshot} />}
        </>
    );
}

export function HoverDock(props: HoverDockProps) {
    const dock = useHoverDock();
    const client = useDockClient(props.port ?? 0);

    return (
        <div className="hover-dock" ref={dock.rootRef}>
            <button
                type="button"
                className="hover-dock-trigger d2-workbench-header-button"
                aria-expanded={dock.open}
                aria-label="에이전트 · 스킬 · 설정 독 토글"
                title="에이전트 · 스킬 · 설정"
                onClick={dock.toggleOpen}
            >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false">
                    <path d="M2 4h12M2 8h12M2 12h12" />
                    <circle cx="5.5" cy="4" r="1.6" fill="currentColor" stroke="none" />
                    <circle cx="10.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
                    <circle cx="6.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
                </svg>
            </button>
            {dock.open && (
                <div className="hover-dock-panel" role="dialog" aria-label="에이전트 스킬 설정 독">
                    {props.port === null ? (
                        <div className="hover-dock-body">
                            <div className="dock-dim">세션을 선택하면 인스턴스 제어 탭이 열립니다</div>
                        </div>
                    ) : (
                        <>
                            <div className="hover-dock-tabs" role="tablist">
                                {DOCK_TAB_KINDS.map((kind) => (
                                    <button
                                        key={kind}
                                        type="button"
                                        role="tab"
                                        aria-selected={dock.tab === kind}
                                        className={`hover-dock-tab${dock.tab === kind ? ' is-active' : ''}`}
                                        onClick={() => dock.setTab(kind)}
                                    >
                                        {DOCK_TAB_TITLES[kind]}
                                    </button>
                                ))}
                            </div>
                            <div className="hover-dock-body" role="tabpanel" data-dock-tab={dock.tab}>
                                <DockTabContent client={client} tab={dock.tab} open={dock.open} locale={props.locale} />
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
