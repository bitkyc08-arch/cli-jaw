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
                <div className="d2-reminders-tabs" role="tablist" aria-label="Reminder views"
                    onKeyDown={(event) => {
                        // Roving tabindex: one tab stop for the group, arrows
                        // move within it (the "2 entry points" M3 finding).
                        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                        event.preventDefault();
                        const next = subview === 'feed' ? 'schedule' : 'feed';
                        setSubview(next);
                        requestAnimationFrame(() => {
                            document.querySelector<HTMLElement>(`.d2-reminders-tabs [role="tab"][aria-selected="true"]`)?.focus();
                        });
                    }}
                >
                    <button type="button" role="tab" aria-selected={subview === 'feed'} tabIndex={subview === 'feed' ? 0 : -1} onClick={() => setSubview('feed')}>Feed</button>
                    <button type="button" role="tab" aria-selected={subview === 'schedule'} tabIndex={subview === 'schedule' ? 0 : -1} onClick={() => setSubview('schedule')}>Schedule</button>
                </div>
            </header>

            <div className="d2-reminders-scroll">
                <RemindersCore variant="panel" active={active && subview === 'feed'} />
                <ScheduleView active={active && subview === 'schedule'} />
            </div>
        </div>
    );
}
