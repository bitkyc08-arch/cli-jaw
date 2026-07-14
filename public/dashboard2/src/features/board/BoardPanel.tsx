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
} from './board-types.ts';
import './board.css';

interface BoardPanelProps {
    active: boolean;
}

const BOARD_TASK_MIME = 'application/x-cli-jaw-board-task';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unable to update the board';
}

export function BoardPanel({ active }: BoardPanelProps): JSX.Element {
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

    const moveTask = useCallback(async (id: string, status: BoardLaneId): Promise<void> => {
        if (busyIds.has(id)) return;
        const task = tasks.find((item) => item.id === id);
        if (!task || task.status === status) return;
        const previousStatus = task.status;
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

    const handleDelete = async (task: BoardTask): Promise<void> => {
        if (busyIds.has(task.id)) return;
        if (!window.confirm(`Delete "${task.title}"?`)) return;
        setBusyIds((current) => new Set(current).add(task.id));
        setError(null);
        try {
            await deleteBoardTask(task.id);
            setTasks((current) => current.filter((item) => item.id !== task.id));
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

    const handleDrop = (lane: BoardLaneId, event: DragEvent<HTMLElement>): void => {
        event.preventDefault();
        const id = event.dataTransfer.getData(BOARD_TASK_MIME) || draggingId;
        setDropLane(null);
        if (id) void moveTask(id, lane);
    };

    return (
        <section
            className="d2-feature-panel d2-board-panel"
            style={{ display: active ? undefined : 'none' }}
            aria-hidden={!active}
        >
            <div className="d2-board-toolbar">
                <span className="d2-board-summary">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
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
                        {BOARD_LANES.map((lane) => {
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
                                                    <div className="d2-board-card-heading">
                                                        <h3>{task.title}</h3>
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
                                                    <div className="d2-board-card-meta">
                                                        <span className="d2-board-status-chip" data-status={task.status}>
                                                            {boardLaneLabel(task.status)}
                                                        </span>
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
        </section>
    );
}
