import { useState } from 'react';
import type { DashboardDetailTab } from '../types';

export function useDashboardView() {
    const [selectedPort, setSelectedPort] = useState<number | null>(null);
    const [activeDetailTab, setActiveDetailTab] = useState<DashboardDetailTab>('overview');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [activityDockCollapsed, setActivityDockCollapsed] = useState(false);
    const [activityDockHeight, setActivityDockHeight] = useState(150);

    return {
        selectedPort,
        setSelectedPort,
        activeDetailTab,
        setActiveDetailTab,
        drawerOpen,
        setDrawerOpen,
        sidebarCollapsed,
        setSidebarCollapsed,
        activityDockCollapsed,
        setActivityDockCollapsed,
        activityDockHeight,
        setActivityDockHeight,
    };
}
