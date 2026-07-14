export type ReminderStatus = 'open' | 'focused' | 'waiting' | 'done';

export type ReminderPriority = 'low' | 'normal' | 'high';

export interface ReminderSubtask {
    id: string;
    title: string;
    done: boolean;
}

export interface Reminder {
    id: string;
    title: string;
    notes: string;
    listId: string;
    status: ReminderStatus;
    priority: ReminderPriority;
    manualRank: number | null;
    dueAt: string | null;
    remindAt: string | null;
    linkedInstance: string | null;
    subtasks: ReminderSubtask[];
    sourceCreatedAt: string;
    sourceUpdatedAt: string;
}

export interface CreateReminderInput {
    title: string;
    notes?: string | null;
    listId?: string | null;
    status?: ReminderStatus;
    priority?: ReminderPriority;
    manualRank?: number | null;
    dueAt?: string | null;
    remindAt?: string | null;
    linkedInstance?: string | null;
}

export type UpdateReminderInput = Partial<CreateReminderInput>;

export type ScheduleGroup = 'today' | 'upcoming' | 'recurring' | 'blocked';

export interface ScheduledItem {
    id: string;
    title: string;
    group: ScheduleGroup;
    cron: string | null;
    runAt: string | null;
    targetPort: number | null;
    payload: string | null;
    nextRunAt: string | null;
    enabled: boolean;
    lastRunAt: string | null;
    lastStatus: string | null;
}
