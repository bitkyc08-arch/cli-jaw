import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { PanelResizer } from './PanelResizer';
import { usePanelLayout } from './PanelLayoutProvider';
import type { RightPanelMode } from './types';

type RightSidebarProps = {
    renderPanel: (mode: RightPanelMode) => ReactNode;
    renderHeaderAction?: ((mode: RightPanelMode, slot: 'top' | 'bottom') => ReactNode) | undefined;
};

const MODE_LABELS: Record<RightPanelMode, string> = {
    folder: 'Folders',
    doc: 'Document preview',
    diff: 'Diff',
    browser: 'Browser',
    ceo: 'Jaw CEO',
};

function FolderIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 6.5h5l1.5 2H17v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15V6.5Z" />
            <path d="M3 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3L9 5.5h6.5A1.5 1.5 0 0 1 17 7v1.5" />
        </svg>
    );
}

function DocIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M5 3.5h6l4 4V16a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 16v-12.5Z" />
            <path d="M11 3.5v4h4M7.5 11h5M7.5 14h4" />
        </svg>
    );
}

function DiffIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M6 4v12M14 4v12M4 7h4M4 13h4M12 10h4M14 8v4" />
        </svg>
    );
}

function BrowserIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="3" y="4" width="14" height="12" rx="2" />
            <path d="M3 7.5h14M6 6h.01M8.5 6h.01" />
        </svg>
    );
}

function CeoIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="10" cy="9" r="3.5" />
            <path d="M4 16.5c0-3.3 2.7-6 6-6s6 2.7 6 6" />
            <path d="M5 7.5C5 5 7.2 3 10 3s5 2 5 4.5" strokeWidth="1.4" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M6 6l8 8M14 6l-8 8" />
        </svg>
    );
}

const MODE_ICONS: Record<RightPanelMode, ReactNode> = {
    folder: <FolderIcon />,
    doc: <DocIcon />,
    diff: <DiffIcon />,
    browser: <BrowserIcon />,
    ceo: <CeoIcon />,
};

const RIGHT_PANEL_TOOLBAR_MODES: RightPanelMode[] = ['folder', 'doc', 'diff', 'browser', 'ceo'];
const CONTENT_OWNED_RIGHT_CHROME: RightPanelMode[] = ['browser', 'ceo'];
const RIGHT_SPLIT_SLOT_MIN_HEIGHT = 180;

export function RightSidebar(props: RightSidebarProps) {
    const { state, dispatch, effectiveRightOpen, rightPanelSplit } = usePanelLayout();
    const rp = state.rightPanel;
    const bodyRef = useRef<HTMLDivElement>(null);
    const widthRef = useRef(rp.width);

    useEffect(() => {
        widthRef.current = rp.width;
    }, [rp.width]);

    const handleWidthDelta = useCallback((delta: number) => {
        const width = widthRef.current - delta;
        widthRef.current = width;
        dispatch({ type: 'SET_RIGHT_WIDTH', width });
    }, [dispatch]);

    const handleWidthEnd = useCallback(() => {
        // save trigger handled by parent persistence layer (L7)
    }, []);

    const handleSplitDelta = useCallback((delta: number) => {
        const el = bodyRef.current;
        if (!el) return;
        const totalHeight = el.clientHeight;
        if (totalHeight === 0) return;
        dispatch({ type: 'SET_RIGHT_SPLIT_RATIO', ratio: rp.splitRatio + delta / totalHeight });
    }, [dispatch, rp.splitRatio]);

    const handleToolbarModeClick = useCallback((mode: RightPanelMode) => {
        dispatch({ type: 'SET_RIGHT_BOTTOM_MODE', mode: null });
        dispatch({ type: 'OPEN_RIGHT_PANEL', mode, slot: 'top' });
    }, [dispatch]);

    const handleSoloSlot = useCallback((slot: 'top' | 'bottom') => {
        dispatch({ type: 'SOLO_RIGHT_SUB', slot });
    }, [dispatch]);

    if (!effectiveRightOpen) return null;

    const isSplit = rightPanelSplit;
    const hideToolbar = rp.ceoDirectOpen && (rp.topMode === 'ceo' || rp.bottomMode === 'ceo');
    const topFr = isSplit ? rp.splitRatio : 1;
    const bottomFr = isSplit ? 1 - rp.splitRatio : 0;
    const activeMode = rp.topMode ?? rp.bottomMode;
    const splitRows = isSplit
        ? `minmax(${RIGHT_SPLIT_SLOT_MIN_HEIGHT}px, ${topFr}fr) auto minmax(${RIGHT_SPLIT_SLOT_MIN_HEIGHT}px, ${bottomFr}fr)`
        : undefined;

    function renderPanelSlot(slot: 'top' | 'bottom', mode: RightPanelMode): ReactNode {
        const label = MODE_LABELS[mode];
        const slotOwnsChrome = !isSplit && CONTENT_OWNED_RIGHT_CHROME.includes(mode);
        return (
            <div
                key={`${slot}-${mode}`}
                className={`right-sub-panel${slotOwnsChrome ? ' has-content-owned-chrome' : ''}`}
                aria-label={label}
            >
                {!slotOwnsChrome && (
                    <div className="right-sub-header">
                        <span className="right-sub-title">{label}</span>
                        <div className="right-sub-actions">
                            {props.renderHeaderAction?.(mode, slot)}
                            {isSplit ? (
                                <button
                                    type="button"
                                    className="right-sub-action"
                                    aria-label={`Show only ${label}`}
                                    title={`Show only ${label}`}
                                    onClick={() => handleSoloSlot(slot)}
                                >
                                    Only
                                </button>
                            ) : null}
                            <button
                                type="button"
                                className="right-sub-action right-sub-close"
                                aria-label={`Close ${label}`}
                                title={`Close ${label}`}
                                onClick={() => dispatch({ type: 'CLOSE_RIGHT_SUB', slot })}
                            >
                                ×
                            </button>
                        </div>
                    </div>
                )}
                <div className="right-sub-content">
                    {props.renderPanel(mode)}
                </div>
            </div>
        );
    }

    return (
        <aside className="right-panel" aria-label="Right sidebar">
            <PanelResizer direction="horizontal" onDelta={handleWidthDelta} onEnd={handleWidthEnd} />
            <div className="right-panel-shell">
                {!hideToolbar && <div className="right-panel-toolbar" aria-label="Right sidebar panels">
                    {RIGHT_PANEL_TOOLBAR_MODES.map(mode => (
                        <button
                            key={mode}
                            type="button"
                            className={`right-panel-mode-button${activeMode === mode ? ' is-active' : ''}`}
                            aria-label={MODE_LABELS[mode]}
                            aria-pressed={activeMode === mode}
                            title={MODE_LABELS[mode]}
                            onClick={() => handleToolbarModeClick(mode)}
                        >
                            {MODE_ICONS[mode]}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="right-panel-close"
                        aria-label="Close right sidebar"
                        title="Close"
                        onClick={() => dispatch({ type: 'SET_RIGHT_OPEN', open: false })}
                    >
                        <CloseIcon />
                    </button>
                </div>}
                <div
                    ref={bodyRef}
                    className={`right-panel-body ${isSplit ? 'is-split-panel' : 'is-single-panel'}`}
                    style={isSplit ? { gridTemplateRows: splitRows } : undefined}
                >
                    {rp.topMode && (
                        renderPanelSlot('top', rp.topMode)
                    )}
                    {isSplit && (
                        <PanelResizer direction="vertical" onDelta={handleSplitDelta} className="right-split-resizer" />
                    )}
                    {rp.bottomMode && (
                        renderPanelSlot('bottom', rp.bottomMode)
                    )}
                </div>
            </div>
        </aside>
    );
}
