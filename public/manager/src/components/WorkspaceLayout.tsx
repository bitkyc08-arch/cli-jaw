import type { CSSProperties, ReactNode } from 'react';

type WorkspaceLayoutProps = {
    navigator: ReactNode;
    workbench: ReactNode;
    inspector: ReactNode;
    mobileNav: ReactNode;
    drawer: ReactNode;
    drawerOpen: boolean;
    sidebarCollapsed: boolean;
    inspectorCollapsed: boolean;
    inspectorHeight: number;
    onCloseDrawer: () => void;
};

type WorkspaceLayoutStyle = CSSProperties & {
    '--activity-dock-height': string;
};

export function WorkspaceLayout(props: WorkspaceLayoutProps) {
    const style: WorkspaceLayoutStyle = {
        '--activity-dock-height': `${props.inspectorHeight}px`,
    };

    const cls = [
        'manager-workspace',
        props.sidebarCollapsed && 'is-sidebar-collapsed',
        props.inspectorCollapsed && 'is-inspector-collapsed',
        props.drawerOpen && 'is-drawer-open',
    ].filter(Boolean).join(' ');

    return (
        <div className={cls} style={style}>
            {props.drawerOpen && <div className="drawer-backdrop" onClick={props.onCloseDrawer} />}
            <aside className="manager-sidebar" aria-label="Jaw instances">{props.navigator}</aside>
            <section className="manager-detail" aria-label="Manager workbench">{props.workbench}</section>
            <section className="manager-activity" aria-label="Manager inspector">{props.inspector}</section>
            <nav className="manager-mobile-nav" aria-label="Mobile dashboard navigation">
                {props.mobileNav}
            </nav>
            {props.drawer}
        </div>
    );
}
