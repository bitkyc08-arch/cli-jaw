export type ReminderStatus = 'open' | 'focused' | 'waiting' | 'done';

export type ReminderPriority = 'low' | 'normal' | 'high';

export interface Reminder {
    id: string;
    title: string;
    status: ReminderStatus;
    priority: ReminderPriority;
    dueAt: string | null;
    remindAt: string | null;
    linkedInstance?: string | null;
    sourceCreatedAt?: string;
    sourceUpdatedAt?: string;
}

export interface CreateReminderInput {
    title: string;
    status?: ReminderStatus;
    priority?: ReminderPriority;
    dueAt?: string | null;
    remindAt?: string | null;
    linkedInstance?: string | null;
}

export type UpdateReminderInput = Partial<CreateReminderInput>;

export type ScheduleGroup = 'today' | 'upcoming' | 'recurring' | 'blocked';

export interface ScheduledItem {
    id: string;
    title: string;
    group?: ScheduleGroup;
    cron: string | null;
    runAt: string | null;
    nextRunAt: string | null;
    enabled: boolean;
    lastRunAt?: string | null;
    lastStatus?: string | null;
    targetPort?: number | null;
}
