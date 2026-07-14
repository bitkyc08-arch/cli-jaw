import type { JSX } from 'react';
import { RemindersCore } from './RemindersCore.tsx';

export function TrayRemindersRoot(): JSX.Element {
    return (
        <main className="d2-tray-reminders-root" aria-label="Tray reminders">
            <RemindersCore variant="tray" active />
        </main>
    );
}
