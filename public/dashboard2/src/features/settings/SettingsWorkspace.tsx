// 074 — Settings central workspace (replaces chat area when active)
import { ArrowLeft } from '@lucide/icons';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { useAppScope } from '../../state/scope.tsx';
import { SettingsSidebar } from './SettingsSidebar.tsx';
import { useDirtyStore } from './settings-dirty-store.ts';
import type { SettingsCategory, SettingsPageId } from './settings-types.ts';
import { AgentPage } from './pages/AgentPage.tsx';
import { BrowserPage } from './pages/BrowserPage.tsx';
import { DisplayPage } from './pages/DisplayPage.tsx';
import { McpPage } from './pages/McpPage.tsx';
import { MemoryPage } from './pages/MemoryPage.tsx';
import { ModelProviderPage } from './pages/ModelProviderPage.tsx';
import { NetworkPage } from './pages/NetworkPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import './settings.css';

const CATEGORIES: SettingsCategory[] = [
    { id: 'display', label: 'Display', description: 'Theme, language, and type', source: 'dashboard', page: DisplayPage },
    { id: 'profile', label: 'Profile', description: 'Identity and reasoning display', source: 'dashboard', page: ProfilePage },
    { id: 'agent', label: 'Agent', description: 'Model and prompt defaults', source: 'instance', page: AgentPage },
    { id: 'model-provider', label: 'Model providers', description: 'Providers and API keys', source: 'instance', page: ModelProviderPage },
    { id: 'memory', label: 'Memory', description: 'Recall and retention', source: 'instance', page: MemoryPage },
    { id: 'mcp', label: 'MCP servers', description: 'Tool server connections', source: 'instance', page: McpPage },
    { id: 'network', label: 'Network', description: 'Proxy and TLS', source: 'instance', page: NetworkPage },
    { id: 'browser', label: 'Browser', description: 'Panel and session behavior', source: 'dashboard', page: BrowserPage },
];

export function SettingsWorkspace(): JSX.Element {
    const {
        selected,
        workspaceMode,
        guardedSetWorkspaceMode,
        registerLeaveGuard,
        unregisterLeaveGuard,
        registerDirtyCheck,
        unregisterDirtyCheck,
    } = useAppScope();
    const [activeId, setActiveId] = useState<SettingsPageId>('display');
    const dirty = useDirtyStore();
    const active = useMemo(() => CATEGORIES.find((category) => category.id === activeId) ?? CATEGORIES[0]!, [activeId]);
    const ActivePage = active.page;

    const leave = async (): Promise<void> => {
        if (!await guardedSetWorkspaceMode('chat')) return;
        dirty.triggerDiscard();
    };

    const selectPage = (next: SettingsPageId): void => {
        if (next === activeId || !dirty.confirmLeave()) return;
        dirty.triggerDiscard();
        setActiveId(next);
    };

    useEffect(() => {
        registerLeaveGuard('settings', dirty.confirmLeave);
        return () => unregisterLeaveGuard('settings');
    }, [dirty.confirmLeave, registerLeaveGuard, unregisterLeaveGuard]);

    useEffect(() => {
        registerDirtyCheck('settings', () => dirty.isDirty);
        return () => unregisterDirtyCheck('settings');
    }, [dirty.isDirty, registerDirtyCheck, unregisterDirtyCheck]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
                event.preventDefault();
                if (workspaceMode === 'settings' && dirty.isDirty) void dirty.triggerSave();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [dirty, workspaceMode]);

    return (
        <div className="d2-settings-workspace">
            <aside className="d2-settings-rail">
                <button className="d2-settings-back" type="button" onClick={() => void leave()}>
                    <Icon icon={ArrowLeft} size={16} />
                    <span>Back to chat</span>
                </button>
                <div className="d2-settings-rail-heading">
                    <strong>Settings</strong>
                    <span>{selected ? `Instance :${selected.port}` : 'Dashboard preferences'}</span>
                </div>
                <SettingsSidebar categories={CATEGORIES} activeId={activeId} onSelect={selectPage} />
            </aside>
            <main className="d2-settings-content">
                <ActivePage key={`${active.id}:${selected?.port ?? 'manager'}`} port={selected?.port ?? null} dirty={dirty} />
            </main>
        </div>
    );
}
