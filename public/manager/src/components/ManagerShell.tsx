import type { CSSProperties, ReactNode } from 'react';

type ManagerShellProps = {
    rail: ReactNode;
    commandBar: ReactNode;
    list: ReactNode;
    detail: ReactNode;
    activity: ReactNode;
    activityHeight: number;
    mobileNav: ReactNode;
    drawer: ReactNode;
};

type ManagerShellStyle = CSSProperties & {
    '--activity-dock-height': string;
};

export function ManagerShell(props: ManagerShellProps) {
    const style: ManagerShellStyle = {
        '--activity-dock-height': `${props.activityHeight}px`,
    };

    return (
        <main className="dashboard-shell manager-shell" style={style}>
            <aside className="manager-rail">{props.rail}</aside>
            <header className="manager-command">{props.commandBar}</header>
            <section className="manager-list" aria-label="Jaw instances">{props.list}</section>
            <section className="manager-detail">{props.detail}</section>
            <section className="manager-activity">{props.activity}</section>
            <nav className="manager-mobile-nav" aria-label="Mobile dashboard navigation">
                {props.mobileNav}
            </nav>
            {props.drawer}
        </main>
    );
}
