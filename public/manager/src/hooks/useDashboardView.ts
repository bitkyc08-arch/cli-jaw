import { useState } from 'react';
import type { DashboardDetailTab, DashboardLocale, DashboardNotesViewMode, DashboardSidebarMode } from '../types';

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
    const [showLatestActivityTitles, setShowLatestActivityTitles] = useState(true);
    const [showInlineLabelEditor, setShowInlineLabelEditor] = useState(true);
    const [showSidebarRuntimeLine, setShowSidebarRuntimeLine] = useState(true);
    const [showSelectedRowActions, setShowSelectedRowActions] = useState(true);
    const [locale, setLocale] = useState<DashboardLocale>('ko');

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
        showLatestActivityTitles,
        setShowLatestActivityTitles,
        showInlineLabelEditor,
        setShowInlineLabelEditor,
        showSidebarRuntimeLine,
        setShowSidebarRuntimeLine,
        showSelectedRowActions,
        setShowSelectedRowActions,
        locale,
        setLocale,
    };
}
