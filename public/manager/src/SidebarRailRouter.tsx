import { useCallback, useEffect, useState, type ReactNode, Suspense } from 'react';
import { ActivityDock } from './components/ActivityDock';
import { InstanceDrawer } from './components/InstanceDrawer';
import { InstanceNavigator } from './components/InstanceNavigator';
import { MobileNav } from './components/MobileNav';
import { SidebarRail } from './components/SidebarRail';
import { Workbench } from './components/Workbench';
import { WorkspaceLayout } from './components/WorkspaceLayout';
import { lazy } from 'react';
import { RightSidebar } from './panels/RightSidebar';
import { BottomPanel, type BottomPanelRenderControls } from './panels/BottomPanel';
import { usePanelLayout } from './panels/PanelLayoutProvider';
import { currentManagerSurface } from './panels/panel-capabilities';
import type { RightPanelMode, BottomPanelTab } from './panels/types';

const TerminalPanel = lazy(() => import('./terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const DiffPanel = lazy(() => import('./diff-panel/DiffPanel').then(m => ({ default: m.DiffPanel })));
const FolderPanel = lazy(() => import('./folder-panel/FolderPanel').then(m => ({ default: m.FolderPanel })));
const DocPanel = lazy(() => import('./doc-panel/DocPanel').then(m => ({ default: m.DocPanel })));
const BrowserPanel = lazy(() => import('./browser-panel/BrowserPanel').then(m => ({ default: m.BrowserPanel })));
import { InstancePreview } from './InstancePreview';
import { DashboardSettingsSidebar, type DashboardSettingsSection } from './dashboard-settings/DashboardSettingsSidebar';
import { DashboardSettingsWorkspace } from './dashboard-settings/DashboardSettingsWorkspace';
import { NotesSidebar, type NotesSidebarMode } from './notes/NotesSidebar';
import { NotesWorkspace } from './notes/NotesWorkspace';
import { DashboardBoardSidebar } from './dashboard-board/DashboardBoardSidebar';
import { DashboardBoardWorkspace } from './dashboard-board/DashboardBoardWorkspace';
import type { BoardView } from './dashboard-board/board-view';
import { DashboardScheduleSidebar, type ScheduleGroup } from './dashboard-schedule/DashboardScheduleSidebar';
import { DashboardScheduleWorkspace } from './dashboard-schedule/DashboardScheduleWorkspace';
import { DashboardRemindersSidebar, type RemindersView } from './dashboard-reminders/DashboardRemindersSidebar';
import { DashboardRemindersWorkspace } from './dashboard-reminders/DashboardRemindersWorkspace';
import { useRemindersFeed } from './dashboard-reminders/useRemindersFeed';
import {
    describeDroppedPathsEvent,
    firstDirectory,
    firstFile,
    useElectronDroppedPaths,
    type ElectronDroppedPathsEvent,
} from './hooks/useElectronDroppedPaths';
import type { HelpTopicId } from './help/helpContent';
import { NotesCommandPalette } from './notes/NotesCommandPalette';
import { NotesCommandProvider } from './notes/notes-command-registry';
import type { NotesModelState } from './notes/useNotesModel';
import type {
    DashboardDetailTab,
    DashboardInstance,
    DashboardNotesAuthoringMode,
    DashboardNotesGraphSettings,
    DashboardNotesViewMode,
    DashboardScanResult,
    DashboardSidebarMode,
    DashboardViewMode,
    NoteMetadata,
    DashboardLocale,
    ManagerEvent,
    DashboardRegistryUi,
} from './types';
import { JawCeoConsole } from './jaw-ceo/JawCeoConsole';
import type { JawCeoController } from './jaw-ceo/useJawCeo';
import type { JawCeoVoiceController } from './jaw-ceo/useJawCeoVoice';
import { ModeSwitch } from './code/ModeSwitch';
const CodeCanvas = lazy(() => import('./code/CodeCanvas').then(m => ({ default: m.CodeCanvas })));
import './code/code.css';

type WorkspaceSurfaceProps = {
    active: boolean;
    children: ReactNode;
};

function WorkspaceSurface(props: WorkspaceSurfaceProps) {
    return <section className={`workspace-surface${props.active ? ' is-active' : ''}`} hidden={!props.active} aria-hidden={!props.active}>{props.children}</section>;
}

type Props = {
    sidebarCollapsed: boolean;
    activityDockCollapsed: boolean;
    activityDockHeight: number;
    drawerOpen: boolean;
    onCloseDrawer: () => void;
    onlineCount: number;
    sidebarMode: DashboardSidebarMode;
    scheduleWorkspaceEnabled: boolean;
    remindersWorkspaceEnabled: boolean;
    onSidebarModeChange: (mode: DashboardSidebarMode) => void;
    onToggleSidebar: () => void;
    helpOpen: boolean;
    onToggleHelp: () => void;
    onOpenHelpTopic: (topic: HelpTopicId) => void;
    settingsSection: DashboardSettingsSection;
    locale: DashboardLocale;
    onSettingsSectionChange: (section: DashboardSettingsSection) => void;
    notesModel: NotesModelState;
    notesSelectedPath: string | null;
    notesSelectedNote: NoteMetadata | null;
    notesDirtyPath: string | null;
    notesHighlightedPath: string | null;
    notesTreeWidth: number;
    notesSidebarMode: NotesSidebarMode;
    notesSearchFocusToken: number;
    notesViewMode: DashboardNotesViewMode;
    notesAuthoringMode: DashboardNotesAuthoringMode;
    notesWordWrap: boolean;
    notesVimMode: boolean;
    onNotesSidebarModeChange: (mode: NotesSidebarMode) => void;
    notesGraphSettings?: DashboardNotesGraphSettings | undefined;
    onOpenNotesSearch: () => void;
    onNotesSelectedPathChange: (path: string | null) => void;
    onNotesDirtyPathChange: (path: string | null) => void;
    onNotesViewModeChange: (mode: DashboardNotesViewMode) => void;
    onNotesAuthoringModeChange: (mode: DashboardNotesAuthoringMode) => void;
    onNotesWordWrapChange: (value: boolean) => void;
    onNotesVimModeChange: (value: boolean) => void;
    onNotesTreeWidthChange: (value: number) => void;
    onNotesGraphSettingsChange: (settings: DashboardNotesGraphSettings) => void;
    onOpenNotesFromPreview?: (path: string) => void;
    boardView: BoardView;
    onBoardViewChange: (view: BoardView) => void;
    scheduleGroup: ScheduleGroup;
    onScheduleGroupChange: (group: ScheduleGroup) => void;
    instances: DashboardInstance[];
    selectedInstance: DashboardInstance | null;
    data: DashboardScanResult | null;
    titlesByPort: Record<number, string>;
    busyPorts: Set<number>;
    activeDetailTab: DashboardDetailTab;
    onDetailTabChange: (tab: DashboardDetailTab) => void;
    workbenchHeader: ReactNode;
    detailContent: (tab: DashboardDetailTab) => ReactNode;
    previewEnabled: boolean;
    previewRefreshKey: number;
    previewTheme: 'dark' | 'light';
    lifecycleMessage: string | null;
    onDismissLifecycleMessage: () => void;
    instanceListContent: ReactNode;
    jawCeoWorkbenchButton?: ReactNode | undefined;
    jawCeoVoiceOverlay?: ReactNode | undefined;
    jawCeo?: JawCeoController | undefined;
    jawCeoVoice?: JawCeoVoiceController | undefined;
    jawCeoOpen?: boolean | undefined;
    jawCeoSelectedPort?: number | null | undefined;
    onJawCeoOpenChange?: ((open: boolean) => void) | undefined;
    onJawCeoOpenWorker?: ((port: number, messageId?: number) => void) | undefined;
    loading: boolean;
    error: string | null;
    registryMessage: string | null;
    managerEvents: ManagerEvent[];
    onToggleActivity: () => void;
    onActivityHeightChange: (height: number) => void;
    onOpenDrawer: () => void;
    onSelectTab: (tab: DashboardDetailTab) => void;
    onToggleActivityFromMobile: () => void;
    drawerProfileFilters: ReactNode;
    dashboardSettingsUi: Parameters<typeof DashboardSettingsWorkspace>[0]['ui'];
    titleSupport: Parameters<typeof DashboardSettingsWorkspace>[0]['titleSupport'];
    onDashboardSettingsPatch: Parameters<typeof DashboardSettingsWorkspace>[0]['onUiPatch'];
    viewMode: DashboardViewMode;
    onViewModeChange: (mode: DashboardViewMode) => void;
    port: number;
    workingDir: string;
};

function renderRightPanelContent(
    mode: RightPanelMode,
    previewFilePath: string | null,
    folderRootPath: string | null,
    onPreviewFile: (path: string) => void,
    onFolderRootChange: (path: string | null) => void,
    selectedInstance: DashboardInstance | null,
    dashboardSettingsUi: DashboardRegistryUi,
    onDashboardSettingsPatch: (patch: Partial<DashboardRegistryUi>) => void,
    notesModel: NotesModelState,
    jawCeoPanel: ReactNode,
): ReactNode {
    const fallback = <div style={{ padding: '12px', color: 'var(--text-dim)', fontSize: '12px' }}>Loading...</div>;
    switch (mode) {
        case 'diff': return <Suspense fallback={fallback}><DiffPanel
            selectedInstance={selectedInstance}
            settings={dashboardSettingsUi}
            folderRootPath={folderRootPath}
            selectedFilePath={previewFilePath}
            onFolderRootChange={onFolderRootChange}
            onPreviewFile={onPreviewFile}
            onSettingsPatch={onDashboardSettingsPatch}
        /></Suspense>;
        case 'folder': return <Suspense fallback={fallback}><FolderPanel selectedFilePath={previewFilePath} externalRootPath={folderRootPath} notesTree={notesModel.tree} notesRoot={notesModel.notesRoot} onRootChange={onFolderRootChange} onPreviewFile={onPreviewFile} /></Suspense>;
        case 'doc': return <Suspense fallback={fallback}><DocPanel filePath={previewFilePath ?? undefined} /></Suspense>;
        case 'browser': return <Suspense fallback={fallback}><BrowserPanel /></Suspense>;
        case 'ceo': return jawCeoPanel;
        default: return null;
    }
}

function renderBottomTabContent(tab: BottomPanelTab, controls: BottomPanelRenderControls): ReactNode {
    const fallback = <div style={{ padding: '12px', color: 'var(--text-dim)', fontSize: '12px' }}>Loading...</div>;
    switch (tab) {
        case 'terminal': return <Suspense fallback={fallback}><TerminalPanel onCollapse={controls.onCollapse} onEmptySessions={controls.onCloseTab} /></Suspense>;
        case 'browser': return <Suspense fallback={fallback}><BrowserPanel onCollapse={controls.onCollapse} /></Suspense>;
        default: return null;
    }
}

export function SidebarRailRouter(props: Props) {
    const panelLayout = usePanelLayout();
    const [rightPreviewFilePath, setRightPreviewFilePath] = useState<string | null>(null);
    const [rightFolderRootPath, setRightFolderRootPath] = useState<string | null>(props.dashboardSettingsUi.rightFolderRootPath);
    const [, setRecentDroppedPaths] = useState<ElectronDroppedPathsEvent | null>(null);
    const [dropNotice, setDropNotice] = useState<string | null>(null);
    const [remindersView, setRemindersView] = useState<RemindersView>('matrix');
    const remindersFeed = useRemindersFeed({ active: props.sidebarMode === 'reminders' });
    const isElectron = currentManagerSurface() === 'electron';
    const desktopPanelsAvailable = isElectron;
    const rightPanelOpen = desktopPanelsAvailable && panelLayout.effectiveRightOpen;
    const rightPanelCeoActive = panelLayout.state.rightPanel.topMode === 'ceo'
        || panelLayout.state.rightPanel.bottomMode === 'ceo';
    const codeWorkingDir = rightFolderRootPath || props.workingDir || '';

    useEffect(() => {
        if (rightPanelCeoActive && props.jawCeoOpen) {
            props.onJawCeoOpenChange?.(false);
        }
    }, [rightPanelCeoActive]);

    useEffect(() => {
        if (isElectron && props.jawCeoOpen && !rightPanelCeoActive) {
            panelLayout.dispatch({ type: 'OPEN_RIGHT_PANEL', mode: 'ceo', slot: 'top', direct: true });
            props.onJawCeoOpenChange?.(false);
        }
    }, [isElectron, props.jawCeoOpen]);

    const ceoConsoleOpen = rightPanelCeoActive || (!isElectron && props.jawCeoOpen);
    const handleCloseCeo = useCallback(() => {
        if (rightPanelCeoActive) {
            const slot = panelLayout.state.rightPanel.topMode === 'ceo' ? 'top' : 'bottom';
            panelLayout.dispatch({ type: 'CLOSE_RIGHT_SUB', slot });
        } else {
            props.onJawCeoOpenChange?.(false);
        }
    }, [rightPanelCeoActive, panelLayout, props.onJawCeoOpenChange]);

    const jawCeoPanel = (ceoConsoleOpen && props.jawCeo && props.jawCeoVoice) ? (
        <JawCeoConsole
            open
            selectedPort={props.jawCeoSelectedPort ?? null}
            ceo={props.jawCeo}
            voice={props.jawCeoVoice}
            onClose={handleCloseCeo}
            onOpenWorker={props.onJawCeoOpenWorker ?? (() => {})}
        />
    ) : null;
    const bottomPanelOpen = desktopPanelsAvailable && panelLayout.state.bottomPanel.open;
    const notesSelectedHiddenByFilter = Boolean(
        props.notesModel.tagFilter
        && props.notesSelectedPath
        && props.notesSelectedNote
        && !props.notesSelectedNote.tags?.includes(props.notesModel.tagFilter),
    );
    function handleRightPreviewFile(path: string): void {
        setRightPreviewFilePath(path);
        panelLayout.dispatch({ type: 'OPEN_RIGHT_PANEL', mode: 'doc', slot: 'bottom' });
    }

    useEffect(() => {
        setRightFolderRootPath(current => (
            current === props.dashboardSettingsUi.rightFolderRootPath
                ? current
                : props.dashboardSettingsUi.rightFolderRootPath
        ));
    }, [props.dashboardSettingsUi.rightFolderRootPath]);

    const updateRightFolderRoot = useCallback((path: string | null): void => {
        setRightFolderRootPath(path);
        props.onDashboardSettingsPatch({ rightFolderRootPath: path });
    }, [props.onDashboardSettingsPatch]);

    const handleDroppedPaths = useCallback((event: ElectronDroppedPathsEvent): void => {
        setRecentDroppedPaths(event);
        setDropNotice(describeDroppedPathsEvent(event));
        if (event.source === 'preview') return;
        const directory = firstDirectory(event.entries);
        if (directory) {
            updateRightFolderRoot(directory.path);
            panelLayout.dispatch({ type: 'OPEN_RIGHT_PANEL', mode: 'folder', slot: 'top' });
            return;
        }
        const file = firstFile(event.entries);
        if (file) handleRightPreviewFile(file.path);
    }, [panelLayout, updateRightFolderRoot]);

    const electronDrop = useElectronDroppedPaths({ onDroppedPaths: handleDroppedPaths });

    const handlePreviewDroppedFiles = useCallback((files: File[]): void => {
        void electronDrop.resolveDroppedFiles(files, 'preview');
    }, [electronDrop]);

    return (
        <NotesCommandProvider>
        {props.jawCeoVoiceOverlay}
        <WorkspaceLayout
            navigatorLabel={props.viewMode === 'code' && props.sidebarMode === 'instances' ? 'Code sessions' : undefined}
            sidebarCollapsed={props.sidebarCollapsed}
            inspectorCollapsed={props.activityDockCollapsed}
            inspectorHeight={props.activityDockCollapsed ? 48 : props.activityDockHeight}
            drawerOpen={props.drawerOpen}
            onCloseDrawer={props.onCloseDrawer}
            rightPanelOpen={rightPanelOpen}
            rightPanelWidth={panelLayout.state.rightPanel.width}
            rightPanelContent={rightPanelOpen ? <RightSidebar renderPanel={mode => renderRightPanelContent(mode, rightPreviewFilePath, rightFolderRootPath, handleRightPreviewFile, updateRightFolderRoot, props.selectedInstance, props.dashboardSettingsUi, props.onDashboardSettingsPatch, props.notesModel, jawCeoPanel)} /> : undefined}
            bottomPanelOpen={bottomPanelOpen}
            bottomPanelHeight={panelLayout.state.bottomPanel.height}
            bottomPanelContent={panelLayout.state.bottomPanel.tabs.length > 0 ? <BottomPanel renderTab={renderBottomTabContent} /> : undefined}
            navigator={(
                <>
                    <SidebarRail
                        onlineCount={props.onlineCount}
                        collapsed={props.sidebarCollapsed}
                        mode={props.sidebarMode}
                        scheduleWorkspaceEnabled={props.scheduleWorkspaceEnabled}
                        remindersWorkspaceEnabled={props.remindersWorkspaceEnabled}
                        onModeChange={props.onSidebarModeChange}
                        onToggleSidebar={props.onToggleSidebar}
                        helpOpen={props.helpOpen}
                        onToggleHelp={props.onToggleHelp}
                    />
                    <ModeSwitch codeMode={props.viewMode === 'code'} onChange={code => { props.onViewModeChange(code ? 'code' : 'jaw'); if (code && props.sidebarMode !== 'instances') props.onSidebarModeChange('instances'); }} />
                    <div id="manager-sidebar-list" className="manager-sidebar-list">
                        {props.sidebarMode === 'settings' ? (
                            <DashboardSettingsSidebar activeSection={props.settingsSection} locale={props.locale} onSectionChange={props.onSettingsSectionChange} />
                        ) : props.sidebarMode === 'notes' ? (
                            <NotesSidebar tree={props.notesModel.filteredTree} loading={props.notesModel.loading} error={props.notesModel.error} notesRoot={props.notesModel.notesRoot} selectedPath={props.notesSelectedPath} dirtyPath={props.notesDirtyPath} highlightedPath={props.notesHighlightedPath} externalFocusPath={props.notesSelectedPath} treeWidth={props.notesTreeWidth} mode={props.notesSidebarMode} searchFocusToken={props.notesSearchFocusToken} tagFilter={props.notesModel.tagFilter} selectedHiddenByFilter={notesSelectedHiddenByFilter} onModeChange={props.onNotesSidebarModeChange} onOpenSearch={props.onOpenNotesSearch} onSelectedPathChange={props.onNotesSelectedPathChange} onRefreshTree={props.notesModel.refresh} onClearTagFilter={() => props.notesModel.setTagFilter(null)} />
                        ) : props.sidebarMode === 'board' ? (
                            <DashboardBoardSidebar view={props.boardView} onViewChange={props.onBoardViewChange} instances={props.instances} titlesByPort={props.titlesByPort} busyPorts={props.busyPorts} />
                        ) : props.scheduleWorkspaceEnabled && props.sidebarMode === 'schedule' ? (
                            <DashboardScheduleSidebar activeGroup={props.scheduleGroup} onGroupChange={props.onScheduleGroupChange} />
                        ) : props.remindersWorkspaceEnabled && props.sidebarMode === 'reminders' ? (
                            <DashboardRemindersSidebar view={remindersView} onViewChange={setRemindersView} items={remindersFeed.items} loading={remindersFeed.loading} onRefresh={() => void remindersFeed.refresh()} onUpdate={(id, patch) => void remindersFeed.update(id, patch)} />
                        ) : props.viewMode === 'code' ? (
                            <section className="code-manager-session-navigator" aria-label="Code sessions">
                                <div id="code-session-sidebar-host" className="code-session-sidebar-host" />
                            </section>
                        ) : (
                            <InstanceNavigator active={props.selectedInstance} hiddenCount={props.instances.filter(instance => instance.hidden).length} collapsed={props.sidebarCollapsed}>
                                {props.instanceListContent}
                            </InstanceNavigator>
                        )}
                    </div>
                </>
            )}
            workbench={(
                <div className="workspace-surface-stack">
                    <NotesCommandPalette active={props.sidebarMode === 'notes'} />
                    {props.lifecycleMessage && (
                        <section className="state lifecycle-state" role="status">
                            <span>{props.lifecycleMessage}</span>
                            <button type="button" className="state-dismiss" aria-label="Dismiss lifecycle message" onClick={props.onDismissLifecycleMessage}>X</button>
                        </section>
                    )}
                    {dropNotice && (
                        <section className="state lifecycle-state" role="status">
                            <span>{dropNotice}</span>
                            <button type="button" className="state-dismiss" aria-label="Dismiss dropped file message" onClick={() => setDropNotice(null)}>X</button>
                        </section>
                    )}
                    <div className="workspace-surface-layer">
                        <WorkspaceSurface active={props.sidebarMode === 'instances' && props.viewMode === 'jaw'}>
                            <Workbench mode={props.activeDetailTab} onModeChange={props.onDetailTabChange} header={props.workbenchHeader} modeActions={props.jawCeoWorkbenchButton} overview={props.detailContent('overview')} preview={(
                                <InstancePreview instance={props.selectedInstance} data={props.data} enabled={props.previewEnabled} active={props.sidebarMode === 'instances' && props.activeDetailTab === 'preview'} refreshKey={props.previewRefreshKey} theme={props.previewTheme} {...(props.onOpenNotesFromPreview ? { onOpenNotesFromPreview: props.onOpenNotesFromPreview } : {})} onOpenDocFromPreview={handleRightPreviewFile} onPreviewDroppedFiles={handlePreviewDroppedFiles} docPanelCapable={desktopPanelsAvailable} />
                            )} logs={props.detailContent('logs')} settings={props.detailContent('settings')} />
                        </WorkspaceSurface>
                        {props.viewMode === 'code' && props.sidebarMode === 'instances' ? (
                            <WorkspaceSurface active>
                                <Suspense fallback={<div style={{ padding: '24px', color: 'var(--text-dim)', fontSize: '13px' }}>Loading Code workspace...</div>}>
                                    <CodeCanvas port={props.port} workingDir={codeWorkingDir} onWorkingDirChange={updateRightFolderRoot} />
                                </Suspense>
                            </WorkspaceSurface>
                        ) : null}
                        <WorkspaceSurface active={props.sidebarMode === 'notes'}>
                            <NotesWorkspace active={props.sidebarMode === 'notes'} selectedPath={props.notesSelectedPath} selectedNote={props.notesSelectedNote} vaultIndex={props.notesModel.index} viewMode={props.notesViewMode} authoringMode={props.notesAuthoringMode} wordWrap={props.notesWordWrap} vimMode={props.notesVimMode} treeWidth={props.notesTreeWidth} notesGraphSettings={props.notesGraphSettings} tagFilter={props.notesModel.tagFilter} onOpenSidebarSearch={props.onOpenNotesSearch} onSelectedPathChange={props.onNotesSelectedPathChange} onDirtyPathChange={props.onNotesDirtyPathChange} onViewModeChange={props.onNotesViewModeChange} onAuthoringModeChange={props.onNotesAuthoringModeChange} onWordWrapChange={props.onNotesWordWrapChange} onVimModeChange={props.onNotesVimModeChange} onTreeWidthChange={props.onNotesTreeWidthChange} onNotesGraphSettingsChange={props.onNotesGraphSettingsChange} onTagSelect={props.notesModel.setTagFilter} onWikiLinkNavigate={props.onNotesSelectedPathChange} />
                        </WorkspaceSurface>
                        <WorkspaceSurface active={props.sidebarMode === 'settings'}>
                            <DashboardSettingsWorkspace activeSection={props.settingsSection} ui={props.dashboardSettingsUi} titleSupport={props.titleSupport} onUiPatch={props.onDashboardSettingsPatch} onOpenHelpTopic={props.onOpenHelpTopic} />
                        </WorkspaceSurface>
                        <WorkspaceSurface active={props.sidebarMode === 'board'}>
                            <DashboardBoardWorkspace active={props.sidebarMode === 'board'} view={props.boardView} onViewChange={props.onBoardViewChange} instances={props.instances} selectedPort={props.selectedInstance?.port ?? null} titlesByPort={props.titlesByPort} busyPorts={props.busyPorts} onOpenHelpTopic={props.onOpenHelpTopic} />
                        </WorkspaceSurface>
                        {props.scheduleWorkspaceEnabled ? (
                            <WorkspaceSurface active={props.sidebarMode === 'schedule'}>
                                <DashboardScheduleWorkspace active={props.sidebarMode === 'schedule'} activeGroup={props.scheduleGroup} busyPorts={props.busyPorts} onOpenHelpTopic={props.onOpenHelpTopic} />
                            </WorkspaceSurface>
                        ) : null}
                        {props.remindersWorkspaceEnabled ? (
                            <WorkspaceSurface active={props.sidebarMode === 'reminders'}>
                                <DashboardRemindersWorkspace active={props.sidebarMode === 'reminders'} view={remindersView} feed={remindersFeed} onRefresh={() => void remindersFeed.refresh()} onCreate={(input) => void remindersFeed.create(input)} onUpdate={(id, patch) => void remindersFeed.update(id, patch)} onOpenHelpTopic={props.onOpenHelpTopic} />
                            </WorkspaceSurface>
                        ) : null}
                    </div>
                </div>
            )}
            inspector={(
                <ActivityDock
                    collapsed={props.activityDockCollapsed}
                    height={props.activityDockHeight}
                    loading={props.loading}
                    error={props.error}
                    lifecycleMessage={props.lifecycleMessage}
                    selectedInstance={props.selectedInstance}
                    registryMessage={props.registryMessage}
                    events={props.managerEvents}
                    onToggle={props.onToggleActivity}
                    onHeightChange={props.onActivityHeightChange}
                />
            )}
            sidePanel={(!isElectron && ceoConsoleOpen) ? jawCeoPanel : undefined}
            mobileNav={<MobileNav activeTab={props.activeDetailTab} onOpenInstances={props.onOpenDrawer} onSelectTab={props.onSelectTab} onToggleActivity={props.onToggleActivityFromMobile} />}
            drawer={(
                <InstanceDrawer open={props.drawerOpen} profileFilters={props.drawerProfileFilters} onClose={props.onCloseDrawer}>
                    {props.instanceListContent}
                </InstanceDrawer>
            )}
        />
        </NotesCommandProvider>
    );
}
