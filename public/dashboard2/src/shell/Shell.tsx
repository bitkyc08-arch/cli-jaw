import type { JSX } from 'react';
import { Sidebar } from './Sidebar.tsx';
import { Workbench } from './Workbench.tsx';

export function Shell(): JSX.Element {
    return (
        <main className="d2-shell">
            <Sidebar />
            <Workbench />
        </main>
    );
}
