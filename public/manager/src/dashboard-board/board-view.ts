import type { BoardLane } from './DashboardBoardSidebar';

export const DONE_PREVIEW_LIMIT = 4;

export type BoardView =
    | { kind: 'overall' }
    | { kind: 'lane'; lane: BoardLane };

export type BoardCard = {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    lane: BoardLane;
    port: number | null;
    source: string;
    persisted: boolean;
};
