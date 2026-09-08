import { useCallback, type ReactNode } from 'react';
import { PanelResizer } from './PanelResizer';
import { BottomPanelTabBar } from './BottomPanelTabBar';
import { usePanelLayout } from './PanelLayoutProvider';
import type { BottomPanelTab } from './types';

export type BottomPanelRenderControls = {
    onCollapse: () => void;
    onCloseTab: () => void;
    ownsChrome: boolean;
};

type BottomPanelProps = {
    renderTab: (tab: BottomPanelTab, controls: BottomPanelRenderControls) => ReactNode;
};

const CONTENT_OWNED_CHROME_TABS: BottomPanelTab[] = ['terminal', 'browser'];

export function BottomPanel(props: BottomPanelProps) {
    const { state, dispatch } = usePanelLayout();
    const bp = state.bottomPanel;

    const handleHeightDelta = useCallback((delta: number) => {
        dispatch({ type: 'SET_BOTTOM_HEIGHT', height: bp.height - delta });
    }, [dispatch, bp.height]);

    const handleCollapse = useCallback(() => {
        dispatch({ type: 'SET_BOTTOM_OPEN', open: false });
    }, [dispatch]);

    const activeTab = bp.activeTab ?? bp.tabs[0] ?? null;
    const ownsChrome = activeTab !== null && CONTENT_OWNED_CHROME_TABS.includes(activeTab);

    if (bp.tabs.length === 0) return null;

    return (
        <div
            className={`bottom-panel ${ownsChrome ? 'has-content-owned-chrome' : ''}`}
            aria-label="Bottom panel"
            aria-hidden={!bp.open}
        >
            <PanelResizer direction="vertical" onDelta={handleHeightDelta} ariaLabel="Resize bottom panel height" ariaValueNow={bp.height} />
            {!ownsChrome && (
                <BottomPanelTabBar
                    tabs={bp.tabs}
                    activeTab={bp.activeTab}
                    onActivate={tab => dispatch({ type: 'SET_BOTTOM_ACTIVE_TAB', tab })}
                    onClose={tab => dispatch({ type: 'CLOSE_BOTTOM_TAB', tab })}
                    onCollapse={handleCollapse}
                />
            )}
            <div className="bottom-panel-content">
                {activeTab && props.renderTab(activeTab, {
                    onCollapse: handleCollapse,
                    onCloseTab: () => dispatch({ type: 'CLOSE_BOTTOM_TAB', tab: activeTab }),
                    ownsChrome,
                })}
            </div>
        </div>
    );
}
