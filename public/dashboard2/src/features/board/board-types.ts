export type BoardLaneId = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';

export interface BoardLaneDefinition {
    id: BoardLaneId;
    label: string;
}

export interface BoardTask {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    status: BoardLaneId;
    port: number | null;
    threadKey: string | null;
    notePath: string | null;
    source: string;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface CreateBoardTaskInput {
    title: string;
    summary?: string | null;
    detail?: string | null;
    status: BoardLaneId;
}

export interface UpdateBoardTaskInput {
    title?: string;
    summary?: string | null;
    detail?: string | null;
    status?: BoardLaneId;
}

export const BOARD_LANES: readonly BoardLaneDefinition[] = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'todo', label: 'Todo' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
] as const;

export function boardLaneLabel(status: BoardLaneId): string {
    return BOARD_LANES.find((lane) => lane.id === status)?.label ?? status;
}
