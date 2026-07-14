import { AlertCircle, LoaderCircle, Plus, RefreshCw, Trash2, X } from '@lucide/icons';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type DragEvent,
    type FormEvent,
    type JSX,
    type KeyboardEvent,
} from 'react';
import { Icon } from '../../shell/Icon.tsx';
import {
    createBoardTask,
    deleteBoardTask,
    listBoardTasks,
    updateBoardTask,
} from './board-api-adapter.ts';
import {
    BOARD_LANES,
    boardLaneLabel,
    type BoardLaneId,
    type BoardTask,
    type UpdateBoardTaskInput,
} from './board-types.ts';
import { BoardTaskDialog } from './BoardTaskDialog.tsx';
import './board.css';

interface BoardPanelProps {
    active: boolean;
}

const BOARD_TASK_MIME = 'application/x-cli-jaw-board-task';
type ContainerMode = 'compact' | 'medium' | 'wide';

type KeyboardDrag = {
    id: string;
    originalTasks: BoardTask[];
    originalStatus: BoardLaneId;
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unable to update the board';
}

export function BoardPanel({ active }: BoardPanelProps): JSX.Element {
    const panelRef = useRef<HTMLElement>(null);
    const loadGenerationRef = useRef(0);
    const [tasks, setTasks] = useState<BoardTask[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const [composerOpen, setComposerOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [createLane, setCreateLane] = useState<BoardLaneId>('backlog');
    const [creating, setCreating] = useState(false);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dropLane, setDropLane] = useState<BoardLaneId | null>(null);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [editingTask, setEditingTask] = useState<BoardTask | null>(null);
    const [containerMode, setContainerMode] = useState<ContainerMode>('wide');
    const [selectedLane, setSelectedLane] = useState<BoardLaneId>('backlog');
    const [keyboardDrag, setKeyboardDrag] = useState<KeyboardDrag | null>(null);

    const loadTasks = useCallback(async (signal?: AbortSignal): Promise<void> => {
        const generation = ++loadGenerationRef.current;
        setLoading(true);
        setError(null);
        try {
            const nextTasks = await listBoardTasks(signal ? { signal } : {});
            if (signal?.aborted || generation !== loadGenerationRef.current) return;
            setTasks(nextTasks);
        } catch (loadError) {
            if (signal?.aborted || generation !== loadGenerationRef.current) return;
            setError(errorMessage(loadError));
        } finally {
            if (!signal?.aborted && generation === loadGenerationRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        void loadTasks(controller.signal);
        return () => controller.abort();
    }, [active, loadTasks]);

    useEffect(() => {
        const panel = panelRef.current;
        if (!panel || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => {
            const width = entry?.contentRect.width ?? panel.clientWidth;
            setContainerMode(width < 420 ? 'compact' : width < 620 ? 'medium' : 'wide');
        });
        observer.observe(panel);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!keyboardDrag) return;
        panelRef.current?.querySelector<HTMLElement>(`[data-board-task-id="${CSS.escape(keyboardDrag.id)}"]`)?.focus();
    }, [keyboardDrag, selectedLane, tasks]);

    const tasksByLane = useMemo(() => {
        const grouped = new Map<BoardLaneId, BoardTask[]>(BOARD_LANES.map((lane) => [lane.id, []]));
        for (const task of tasks) grouped.get(task.status)?.push(task);
        return grouped;
    }, [tasks]);

    const handleCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        const trimmedTitle = title.trim();
        if (!trimmedTitle || creating) return;
        setCreating(true);
        setError(null);
        try {
            const task = await createBoardTask({
                title: trimmedTitle,
                status: createLane,
            });
            setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
            setTitle('');
            setComposerOpen(false);
            setAnnouncement(`${task.title} created in ${boardLaneLabel(task.status)}`);
        } catch (createError) {
            setError(errorMessage(createError));
        } finally {
            setCreating(false);
        }
    };

    const moveTask = useCallback(async (id: string, status: BoardLaneId, originalStatus?: BoardLaneId): Promise<void> => {
        if (busyIds.has(id)) return;
        const task = tasks.find((item) => item.id === id);
        if (!task || (task.status === status && originalStatus === undefined)) return;
        const previousStatus = originalStatus ?? task.status;
        setBusyIds((current) => new Set(current).add(id));
        setTasks((current) => current.map((item) => item.id === id ? { ...item, status } : item));
        setError(null);
        setAnnouncement(`${task.title} moved to ${boardLaneLabel(status)}`);
        try {
            const updated = await updateBoardTask(id, { status });
            setTasks((current) => current.map((item) => item.id === id ? updated : item));
        } catch (moveError) {
            setTasks((current) => current.map((item) => item.id === id ? { ...item, status: previousStatus } : item));
            setError(errorMessage(moveError));
            setAnnouncement(`${task.title} returned to ${boardLaneLabel(previousStatus)}`);
        } finally {
            setBusyIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            });
        }
    }, [busyIds, tasks]);

    const handleDelete = async (task: BoardTask, confirmed = false): Promise<void> => {
        if (busyIds.has(task.id)) return;
        if (!confirmed && !window.confirm(`Delete "${task.title}"?`)) return;
        setBusyIds((current) => new Set(current).add(task.id));
        setError(null);
        try {
            await deleteBoardTask(task.id);
            setTasks((current) => current.filter((item) => item.id !== task.id));
            setEditingTask((current) => current?.id === task.id ? null : current);
            setAnnouncement(`${task.title} deleted`);
        } catch (deleteError) {
            setError(errorMessage(deleteError));
        } finally {
            setBusyIds((current) => {
                const next = new Set(current);
                next.delete(task.id);
                return next;
            });
        }
    };

    const handleDialogSave = async (id: string, input: UpdateBoardTaskInput): Promise<void> => {
        if (busyIds.has(id)) return;
        setBusyIds((current) => new Set(current).add(id));
        setError(null);
        try {
            const updated = await updateBoardTask(id, input);
            setTasks((current) => current.map((item) => item.id === id ? updated : item));
            setEditingTask(null);
            setAnnouncement(`${updated.title} updated`);
        } catch (saveError) {
            setError(errorMessage(saveError));
        } finally {
            setBusyIds((current) => {
                const next = new Set(current);
                next.delete(id);
                return next;
            });
        }
    };

    const handleKeyboardDrag = (task: BoardTask, event: KeyboardEvent<HTMLElement>): void => {
        const grabbed = keyboardDrag?.id === task.id;
        if (event.key === ' ' && !keyboardDrag) {
            event.preventDefault();
            setKeyboardDrag({ id: task.id, originalTasks: tasks, originalStatus: task.status });
            setDraggingId(task.id);
            setSelectedLane(task.status);
            setAnnouncement(`${task.title} grabbed. Use arrow keys to move, Enter to drop, or Escape to cancel.`);
            return;
        }
        if (!grabbed) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            setTasks(keyboardDrag.originalTasks);
            setKeyboardDrag(null);
            setDraggingId(null);
            setAnnouncement(`${task.title} move cancelled`);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            const originalStatus = keyboardDrag.originalStatus;
            setKeyboardDrag(null);
            setDraggingId(null);
            setAnnouncement(`${task.title} dropped in ${boardLaneLabel(task.status)}`);
            void moveTask(task.id, task.status, originalStatus);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const currentIndex = BOARD_LANES.findIndex((lane) => lane.id === task.status);
            const nextIndex = Math.max(0, Math.min(BOARD_LANES.length - 1, currentIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
            const nextStatus = BOARD_LANES[nextIndex]?.id ?? task.status;
            if (nextStatus === task.status) return;
            setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: nextStatus } : item));
            setSelectedLane(nextStatus);
            setAnnouncement(`${task.title} moved to ${boardLaneLabel(nextStatus)}`);
            return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setTasks((current) => {
                const laneIndexes = current.flatMap((item, index) => item.status === task.status ? [index] : []);
                const index = current.findIndex((item) => item.id === task.id);
                const lanePosition = laneIndexes.indexOf(index);
                const targetPosition = lanePosition + (event.key === 'ArrowUp' ? -1 : 1);
                const targetIndex = laneIndexes[targetPosition];
                if (targetIndex === undefined) return current;
                const next = [...current];
                [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
                setAnnouncement(`${task.title} moved to position ${targetPosition + 1} in ${boardLaneLabel(task.status)}`);
                return next;
            });
        }
    };

    const handleDrop = (lane: BoardLaneId, event: DragEvent<HTMLElement>): void => {
        event.preventDefault();
        const id = event.dataTransfer.getData(BOARD_TASK_MIME) || draggingId;
        setDropLane(null);
        if (id) void moveTask(id, lane);
    };

    return (
        <section
            ref={panelRef}
            className={`d2-feature-panel d2-board-panel is-${containerMode}`}
            style={{ display: active ? undefined : 'none' }}
            aria-hidden={!active}
        >
            <div className="d2-board-toolbar">
                <span className="d2-board-summary">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                {containerMode === 'compact' ? (
                    <label className="d2-board-lane-picker">
                        <span>Lane</span>
                        <select value={selectedLane} onChange={(event) => {
                            const lane = event.currentTarget.value as BoardLaneId;
                            if (keyboardDrag) {
                                setTasks((current) => current.map((item) => item.id === keyboardDrag.id ? { ...item, status: lane } : item));
                                setAnnouncement(`Target lane ${boardLaneLabel(lane)}`);
                            }
                            setSelectedLane(lane);
                        }}>
                            {BOARD_LANES.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
                        </select>
                    </label>
                ) : null}
                <span className="d2-board-toolbar-actions">
                    <button
                        type="button"
                        className="d2-board-icon-button"
                        onClick={() => void loadTasks()}
                        disabled={loading}
                        aria-label="Refresh board"
                        title="Refresh board"
                    >
                        <Icon icon={loading ? LoaderCircle : RefreshCw} size={15} />
                    </button>
                    <button
                        type="button"
                        className="d2-board-icon-button d2-board-create-button"
                        onClick={() => setComposerOpen((open) => !open)}
                        aria-expanded={composerOpen}
                        aria-controls="d2-board-composer"
                        aria-label="Create task"
                        title="Create task"
                    >
                        <Icon icon={composerOpen ? X : Plus} size={16} />
                    </button>
                </span>
            </div>

            {composerOpen ? (
                <form id="d2-board-composer" className="d2-board-composer" onSubmit={(event) => void handleCreate(event)}>
                    <label className="d2-board-field d2-board-title-field">
                        <span>Title</span>
                        <input
                            autoFocus
                            type="text"
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            maxLength={500}
                            disabled={creating}
                            placeholder="Task title"
                        />
                    </label>
                    <label className="d2-board-field">
                        <span>Lane</span>
                        <select
                            value={createLane}
                            onChange={(event) => setCreateLane(event.target.value as BoardLaneId)}
                            disabled={creating}
                        >
                            {BOARD_LANES.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
                        </select>
                    </label>
                    <button className="d2-board-submit" type="submit" disabled={creating || !title.trim()}>
                        {creating ? <Icon icon={LoaderCircle} size={14} /> : <Icon icon={Plus} size={14} />}
                        <span>{creating ? 'Creating' : 'Add task'}</span>
                    </button>
                </form>
            ) : null}

            <div className="d2-board-status-region" aria-live="polite" aria-atomic="true">
                {announcement}
            </div>

            {error ? (
                <div className="d2-board-error" role="alert">
                    <Icon icon={AlertCircle} size={15} />
                    <span>{error}</span>
                    <button type="button" onClick={() => void loadTasks()}>Retry</button>
                </div>
            ) : null}

            {loading && tasks.length === 0 ? (
                <div className="d2-board-state" role="status">
                    <Icon icon={LoaderCircle} size={17} />
                    <span>Loading board</span>
                </div>
            ) : (
                <div className="d2-board-canvas" aria-label="Task board">
                    <div className="d2-board-lanes">
                        {BOARD_LANES.filter((lane) => containerMode !== 'compact' || lane.id === selectedLane).map((lane) => {
                            const laneTasks = tasksByLane.get(lane.id) ?? [];
                            const isDropTarget = dropLane === lane.id;
                            return (
                                <section
                                    key={lane.id}
                                    className={`d2-board-lane${isDropTarget ? ' is-drop-target' : ''}`}
                                    aria-labelledby={`d2-board-lane-${lane.id}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        if (draggingId) setDropLane(lane.id);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = 'move';
                                    }}
                                    onDragLeave={(event) => {
                                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropLane(null);
                                    }}
                                    onDrop={(event) => handleDrop(lane.id, event)}
                                >
                                    <header className="d2-board-lane-header">
                                        <h2 id={`d2-board-lane-${lane.id}`}>{lane.label}</h2>
                                        <span>{laneTasks.length}</span>
                                    </header>
                                    <div className="d2-board-card-list" role="list">
                                        {laneTasks.length === 0 ? (
                                            <div className="d2-board-lane-empty">
                                                <span>{isDropTarget ? 'Drop task here' : 'No tasks'}</span>
                                            </div>
                                        ) : laneTasks.map((task) => {
                                            const isBusy = busyIds.has(task.id);
                                            return (
                                                <article
                                                    key={task.id}
                                                    className={`d2-board-card${draggingId === task.id ? ' is-dragging' : ''}`}
                                                    role="listitem"
                                                    draggable={!isBusy}
                                                    aria-busy={isBusy}
                                                    onDragStart={(event) => {
                                                        event.dataTransfer.effectAllowed = 'move';
                                                        event.dataTransfer.setData(BOARD_TASK_MIME, task.id);
                                                        event.dataTransfer.setData('text/plain', task.title);
                                                        setDraggingId(task.id);
                                                        setAnnouncement(`${task.title} picked up`);
                                                    }}
                                                    onDragEnd={() => {
                                                        setDraggingId(null);
                                                        setDropLane(null);
                                                    }}
                                                >
                                                    <div
                                                        className="d2-board-card-body"
                                                        role="button"
                                                        data-board-task-id={task.id}
                                                        tabIndex={isBusy ? -1 : 0}
                                                        aria-pressed={keyboardDrag?.id === task.id}
                                                        onClick={() => { if (!keyboardDrag) setEditingTask(task); }}
                                                        onKeyDown={(event) => handleKeyboardDrag(task, event)}
                                                    >
                                                        <div className="d2-board-card-heading"><h3>{task.title}</h3></div>
                                                        {task.summary ? <p className="d2-board-card-summary">{task.summary}</p> : null}
                                                        <div className="d2-board-card-meta">
                                                            <span className="d2-board-status-chip" data-status={task.status}>{boardLaneLabel(task.status)}</span>
                                                        </div>
                                                    </div>
                                                    <div className="d2-board-card-actions">
                                                        <button
                                                            type="button"
                                                            className="d2-board-card-delete"
                                                            onClick={() => void handleDelete(task)}
                                                            disabled={isBusy}
                                                            aria-label={`Delete ${task.title}`}
                                                            title="Delete task"
                                                        >
                                                            <Icon icon={Trash2} size={13} />
                                                        </button>
                                                    </div>
                                                </article>
                                            );
                                        })}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                </div>
            )}
            <BoardTaskDialog
                task={editingTask}
                onClose={() => setEditingTask(null)}
                onSave={handleDialogSave}
                onDelete={(task) => handleDelete(task, true)}
                saving={editingTask ? busyIds.has(editingTask.id) : false}
            />
        </section>
    );
}
