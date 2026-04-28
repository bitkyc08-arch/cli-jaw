import type { ReactNode } from 'react';
import type { DashboardInstance } from '../types';

type InstanceNavigatorProps = {
    active: DashboardInstance | null;
    hiddenCount: number;
    collapsed: boolean;
    children: ReactNode;
};

export function InstanceNavigator(props: InstanceNavigatorProps) {
    if (props.collapsed) {
        return <div className="instance-navigator is-collapsed">{props.children}</div>;
    }

    return (
        <section className="instance-navigator" aria-label="Instance navigator">
            <header className="instance-navigator-header">
                <div>
                    <p className="eyebrow">Navigator</p>
                    <strong>{props.active ? `:${props.active.port}` : 'No active target'}</strong>
                </div>
                <span>{props.hiddenCount} hidden</span>
            </header>
            <div className="instance-navigator-scroll">{props.children}</div>
        </section>
    );
}
