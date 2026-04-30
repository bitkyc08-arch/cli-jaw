import { useState } from 'react';
import type { DashboardDetailTab, DashboardNotesViewMode, DashboardSidebarMode } from '../types';

export function useDashboardView() {
    const [selectedPort, setSelectedPort] = useState<number | null>(null);
    const [activeDetailTab, setActiveDetailTab] = useState<DashboardDetailTab>('overview');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [activityDockCollapsed, setActivityDockCollapsed] = useState(false);
    const [activityDockHeight, setActivityDockHeight] = useState(150);
    const [sidebarMode, setSidebarMode] = useState<DashboardSidebarMode>('instances');
    const [notesSelectedPath, setNotesSelectedPath] = useState<string | null>(null);
    const [notesViewMode, setNotesViewMode] = useState<DashboardNotesViewMode>('split');
    const [notesWordWrap, setNotesWordWrap] = useState(true);
    const [notesTreeWidth, setNotesTreeWidth] = useState(280);

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
        sidebarMode,
        setSidebarMode,
        notesSelectedPath,
        setNotesSelectedPath,
        notesViewMode,
        setNotesViewMode,
        notesWordWrap,
        setNotesWordWrap,
        notesTreeWidth,
        setNotesTreeWidth,
    };
}
