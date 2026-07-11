// 049 — v4 shell grid: the shell owns the sidebar collapse state
// (260px <-> 0px track, spec 010 §1); pane state stays in scope.tsx.
import { useState, type JSX } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { Workbench } from './Workbench.tsx';

export function Shell(): JSX.Element {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    return (
        <main className={sidebarCollapsed ? 'd2-shell d2-sb-closed' : 'd2-shell'}>
            <Sidebar onClose={() => setSidebarCollapsed(true)} />
            <Workbench
                sidebarCollapsed={sidebarCollapsed}
                onOpenSidebar={() => setSidebarCollapsed(false)}
            />
        </main>
    );
}
