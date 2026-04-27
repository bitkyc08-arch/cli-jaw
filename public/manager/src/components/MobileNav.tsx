import type { DashboardDetailTab } from '../types';

type MobileNavProps = {
    activeTab: DashboardDetailTab;
    onOpenInstances: () => void;
    onSelectTab: (tab: DashboardDetailTab) => void;
    onToggleActivity: () => void;
};

export function MobileNav(props: MobileNavProps) {
    return (
        <div className="mobile-nav-actions">
            <button type="button" onClick={props.onOpenInstances}>Instances</button>
            <button
                type="button"
                className={props.activeTab === 'preview' ? 'is-active' : ''}
                onClick={() => props.onSelectTab('preview')}
            >
                Preview
            </button>
            <button type="button" onClick={props.onToggleActivity}>Activity</button>
            <button
                type="button"
                className={props.activeTab === 'settings' ? 'is-active' : ''}
                onClick={() => props.onSelectTab('settings')}
            >
                More
            </button>
        </div>
    );
}
