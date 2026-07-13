import { type JSX } from 'react';

interface RemindersPanelProps {
    active: boolean;
}

export function RemindersPanel({ active }: RemindersPanelProps): JSX.Element {
    return (
        <div className="d2-feature-panel d2-reminders-panel" style={{ display: active ? undefined : 'none' }}>
            <div className="d2-feature-panel-placeholder">
                <span className="d2-feature-panel-icon">Calendar reminder</span>
                <h3>Reminders &amp; Schedule</h3>
                <p>Reminders and schedule will appear here</p>
            </div>
        </div>
    );
}
