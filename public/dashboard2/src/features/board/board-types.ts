export type BoardLaneId = 'backlog' | 'todo' | 'in_progress' | 'done';

export interface BoardLaneDefinition {
    id: BoardLaneId;
    label: string;
}

export interface BoardTask {
    id: string;
    title: string;
    assignee: string | null;
    status: BoardLaneId;
    createdAt: string | null;
}

export interface CreateBoardTaskInput {
    title: string;
    assignee?: string;
    status: BoardLaneId;
}

export interface UpdateBoardTaskInput {
    title?: string;
    assignee?: string | null;
    status?: BoardLaneId;
}

export const BOARD_LANES: readonly BoardLaneDefinition[] = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'todo', label: 'Todo' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
] as const;

export function boardLaneLabel(status: BoardLaneId): string {
    return BOARD_LANES.find((lane) => lane.id === status)?.label ?? status;
}
