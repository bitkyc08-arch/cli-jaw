import type { ReactNode } from 'react';

type CommandCenterProps = {
    title: ReactNode;
    search: ReactNode;
    filters: ReactNode;
    summary: ReactNode;
    actions: ReactNode;
    mobileMenuButton: ReactNode;
};

export function CommandCenter(props: CommandCenterProps) {
    return (
        <div className="command-center command-bar">
            <div className="command-primary">
                {props.mobileMenuButton}
                <div className="command-title">{props.title}</div>
                <div className="command-search">{props.search}</div>
                <div className="command-actions">{props.actions}</div>
            </div>
            <div className="command-secondary">
                <div className="command-filter-strip">{props.filters}</div>
                <div className="command-summary">{props.summary}</div>
            </div>
        </div>
    );
}
