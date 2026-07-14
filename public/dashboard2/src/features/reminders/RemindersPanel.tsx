import { useState, type JSX } from 'react';
import { RemindersCore } from './RemindersCore.tsx';
import { ScheduleView } from './ScheduleView.tsx';

interface RemindersPanelProps {
    active: boolean;
}

type RemindersSubview = 'feed' | 'schedule';

export function RemindersPanel({ active }: RemindersPanelProps): JSX.Element {
    const [subview, setSubview] = useState<RemindersSubview>('feed');

    return (
        <div className="d2-feature-panel d2-reminders-panel" style={{ display: active ? undefined : 'none' }}>
            <header className="d2-reminders-toolbar">
                <div>
                    <strong>Reminders</strong>
                    <span>{subview === 'feed' ? 'Tasks and follow-ups' : 'Scheduled work'}</span>
                </div>
                <div className="d2-reminders-tabs" role="tablist" aria-label="Reminder views">
                    <button type="button" role="tab" aria-selected={subview === 'feed'} onClick={() => setSubview('feed')}>Feed</button>
                    <button type="button" role="tab" aria-selected={subview === 'schedule'} onClick={() => setSubview('schedule')}>Schedule</button>
                </div>
            </header>

            <div className="d2-reminders-scroll">
                <RemindersCore variant="panel" active={active && subview === 'feed'} />
                <ScheduleView active={active && subview === 'schedule'} />
            </div>
        </div>
    );
}
