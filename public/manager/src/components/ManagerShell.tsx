import type { CSSProperties, ReactNode } from 'react';

type ManagerShellProps = {
    commandBar: ReactNode;
    workspace: ReactNode;
    activityHeight: number;
    sidebarCollapsed: boolean;
};

type ManagerShellStyle = CSSProperties & {
    '--activity-dock-height': string;
};

export function ManagerShell(props: ManagerShellProps) {
    const style: ManagerShellStyle = {
        '--activity-dock-height': `${props.activityHeight}px`,
    };

    return (
        <main className={`dashboard-shell manager-shell${props.sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`} style={style}>
            <header className="manager-command">{props.commandBar}</header>
            {props.workspace}
        </main>
    );
}
