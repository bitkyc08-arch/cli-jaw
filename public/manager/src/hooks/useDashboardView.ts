import { useState } from 'react';
import type { DashboardDetailTab, DashboardPreviewMode } from '../types';

export function useDashboardView() {
    const [selectedPort, setSelectedPort] = useState<number | null>(null);
    const [previewMode, setPreviewMode] = useState<DashboardPreviewMode>('proxy');
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [activeDetailTab, setActiveDetailTab] = useState<DashboardDetailTab>('overview');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [activityDockCollapsed, setActivityDockCollapsed] = useState(false);
    const [activityDockHeight, setActivityDockHeight] = useState(150);

    return {
        selectedPort,
        setSelectedPort,
        previewMode,
        setPreviewMode,
        previewEnabled,
        setPreviewEnabled,
        activeDetailTab,
        setActiveDetailTab,
        drawerOpen,
        setDrawerOpen,
        activityDockCollapsed,
        setActivityDockCollapsed,
        activityDockHeight,
        setActivityDockHeight,
    };
}
