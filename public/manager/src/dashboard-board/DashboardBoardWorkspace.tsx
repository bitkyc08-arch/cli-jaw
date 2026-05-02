import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { DashboardInstance } from '../types';
import { BOARD_LANES, type BoardLane } from './DashboardBoardSidebar';
import { listTasks, createTask, updateTask, deleteTask, type DashboardTask, type DashboardTaskPatch } from './board-api';
import { DashboardBoardTaskDialog, type BoardTaskDialogCard } from './DashboardBoardTaskDialog';
import { RUNNING_CHIP_MIME, decodeRunningChip, deriveRunningChips, encodeRunningChip } from './running-chips';

type BoardCard = {
    id: string;
    title: string;
    summary: string | null;
    detail: string | null;
    lane: BoardLane;
    port: number | null;
    source: string;
    persisted: boolean;
};

type Props = {
    active: boolean;
    activeLane: BoardLane;
    instances: DashboardInstance[];
    selectedPort: number | null;
    titlesByPort: Record<number, string>;
    busyPorts: Set<number>;
};

const BOARD_TASK_MIME = 'application/x-jaw-board-task';

function CardActionIcon(props: { kind: 'open' | 'move' | 'delete' }) {
    if (props.kind === 'open') {
        return (
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M7 4h-2.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V13" />
                <path d="M10 3h7v7" />
                <path d="M9 11 17 3" />
            </svg>
        );
    }
    if (props.kind === 'move') {
        return (
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M10 2v16" />
                <path d="M6 6 10 2l4 4" />
                <path d="m6 14 4 4 4-4" />
                <path d="M2 10h16" />
                <path d="m6 6-4 4 4 4" />
                <path d="m14 6 4 4-4 4" />
            </svg>
        );
    }
    return (
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 5h14" />
            <path d="M8 5V3h4v2" />
            <path d="M6 8v8" />
            <path d="M10 8v8" />
            <path d="M14 8v8" />
            <path d="M5 5l1 13h8l1-13" />
        </svg>
    );
}

function encodeBoardTask(card: BoardCard): string {
    return JSON.stringify({ id: card.id, lane: card.lane });
}

function decodeBoardTask(e: DragEvent): { id: string; lane: BoardLane } | null {
    const raw = e.dataTransfer.getData(BOARD_TASK_MIME);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<{ id: string; lane: BoardLane }>;
        if (typeof parsed.id !== 'string') return null;
        const lane = BOARD_LANES.find(candidate => candidate.id === parsed.lane)?.id;
        if (!lane) return null;
        return { id: parsed.id, lane };
    } catch {
        return null;
    }
}

function hasDragType(e: DragEvent, type: string): boolean {
    return Array.from(e.dataTransfer.types).includes(type);
}

function taskToCard(t: DashboardTask): BoardCard {
    return {
        id: t.id,
        title: t.title,
        summary: t.summary ?? null,
        detail: t.detail ?? null,
        lane: t.lane,
        port: t.port,
        source: t.source,
        persisted: true,
    };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const text = value.trim();
    return text ? text : null;
}

export function DashboardBoardWorkspace(props: Props) {
    const [tasks, setTasks] = useState<DashboardTask[]>([]);
    const [composerLane, setComposerLane] = useState<BoardLane | null>(null);
    const [composerTitle, setComposerTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const [movePopoverFor, setMovePopoverFor] = useState<string | null>(null);
    const [dropTarget, setDropTarget] = useState<BoardLane | null>(null);
    const [cardDropTarget, setCardDropTarget] = useState<string | null>(null);
    const [dialogCardId, setDialogCardId] = useState<string | null>(null);
    const [dialogBusy, setDialogBusy] = useState(false);
    const popoverRef = useRef<HTMLDivElement | null>(null);

    const reload = useCallback(async () => {
        try { setTasks(await listTasks()); }
        catch { /* ignore */ }
    }, []);

    useEffect(() => {
        if (!props.active) return;
        void reload();
    }, [props.active, reload]);

    useEffect(() => {
        if (!movePopoverFor) return;
        const handler = (e: MouseEvent) => {
            if (!popoverRef.current) return;
            if (!popoverRef.current.contains(e.target as Node)) setMovePopoverFor(null);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [movePopoverFor]);

    const onAdd = useCallback(async (lane: BoardLane) => {
        const title = composerTitle.trim();
        if (!title || busy) return;
        setBusy(true);
        try {
            await createTask({ title, lane });
            setComposerTitle('');
            setComposerLane(null);
            await reload();
        } catch { /* ignore */ }
        finally { setBusy(false); }
    }, [composerTitle, busy, reload]);

    const onMove = useCallback(async (id: string, lane: BoardLane) => {
        setMovePopoverFor(null);
        try { await updateTask(id, { lane }); await reload(); }
        catch { /* ignore */ }
    }, [reload]);

    const onDelete = useCallback(async (id: string) => {
        try { await deleteTask(id); await reload(); }
        catch { /* ignore */ }
    }, [reload]);

    const onSaveCardDetails = useCallback(async (id: string, patch: DashboardTaskPatch) => {
        if (dialogBusy) return;
        setDialogBusy(true);
        try {
            const updated = await updateTask(id, patch);
            setTasks(current => current.map(task => {
                if (task.id !== id) return task;
                return {
                    ...task,
                    ...updated,
                    summary: patch.summary !== undefined
                        ? normalizeOptionalText(patch.summary)
                        : updated.summary ?? task.summary,
                    detail: patch.detail !== undefined
                        ? normalizeOptionalText(patch.detail)
                        : updated.detail ?? task.detail,
                };
            }));
            setDialogCardId(null);
        } catch { /* ignore */ }
        finally { setDialogBusy(false); }
    }, [dialogBusy]);

    const onAttachInstance = useCallback(async (id: string, port: number) => {
        try { await updateTask(id, { port }); await reload(); }
        catch { /* ignore */ }
    }, [reload]);

    const onDetachInstance = useCallback(async (id: string) => {
        try { await updateTask(id, { port: null }); await reload(); }
        catch { /* ignore */ }
    }, [reload]);

    const onDropToLane = useCallback((lane: BoardLane, e: DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const task = decodeBoardTask(e);
        if (!task || task.lane === lane) return;
        void onMove(task.id, lane);
    }, [onMove]);

    const onDropToCard = useCallback((id: string, e: DragEvent) => {
        if (!hasDragType(e, RUNNING_CHIP_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setCardDropTarget(null);
        const chip = decodeRunningChip(e);
        if (!chip) return;
        void onAttachInstance(id, chip.port);
    }, [onAttachInstance]);

    const cards = useMemo(() => tasks.map(taskToCard), [tasks]);
    const dialogCard = useMemo<BoardTaskDialogCard | null>(() => {
        const card = dialogCardId ? cards.find(candidate => candidate.id === dialogCardId) : null;
        return card ? {
            id: card.id,
            title: card.title,
            summary: card.summary,
            detail: card.detail,
        } : null;
    }, [cards, dialogCardId]);

    const runningChips = useMemo(
        () => deriveRunningChips(props.instances, props.titlesByPort, props.busyPorts),
        [props.instances, props.titlesByPort, props.busyPorts],
    );
    const runningChipByPort = useMemo(() => new Map(runningChips.map(chip => [chip.port, chip])), [runningChips]);

    return (
        <section className="dashboard-board-workspace" aria-hidden={!props.active}>
            <header className="dashboard-board-workspace-header">
                <div className="dashboard-board-workspace-header-text">
                    <h2>Board</h2>
                    <p className="dashboard-board-workspace-subtitle">
                        Create human-owned kanban blocks, then drag running instance blocks into a card to attach context without touching the instance itself.
                    </p>
                </div>
            </header>
            <div className="dashboard-board-lanes">
                {BOARD_LANES.map(lane => {
                    const laneCards = cards.filter(card => card.lane === lane.id);
                    const isComposing = composerLane === lane.id;
                    const isDropTarget = dropTarget === lane.id;
                    return (
                        <div
                            key={lane.id}
                            className={`dashboard-board-lane${props.activeLane === lane.id ? ' is-focused' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
                            data-lane={lane.id}
                            onDragOver={e => {
                                if (hasDragType(e, BOARD_TASK_MIME)) {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    if (dropTarget !== lane.id) setDropTarget(lane.id);
                                }
                            }}
                            onDragLeave={() => {
                                if (dropTarget === lane.id) setDropTarget(null);
                            }}
                            onDrop={e => onDropToLane(lane.id, e)}
                        >
                            <header className="dashboard-board-lane-header">
                                <span className="dashboard-board-lane-title">{lane.label}</span>
                                <span className="dashboard-board-lane-count">{laneCards.length}</span>
                            </header>
                            <ul className="dashboard-board-lane-cards">
                                {laneCards.length === 0 ? (
                                    <li className="dashboard-board-lane-empty">No items</li>
                                ) : laneCards.map(card => {
                                    const assignedChip = card.port === null ? null : runningChipByPort.get(card.port) ?? null;
                                    const isCardDropTarget = cardDropTarget === card.id;
                                    return (
                                        <li
                                            key={card.id}
                                            className={`dashboard-board-card${isCardDropTarget ? ' is-instance-drop-target' : ''}`}
                                            data-lane={card.lane}
                                            data-source={card.source}
                                            data-persisted={card.persisted ? 'true' : 'false'}
                                            draggable
                                            onDragStart={e => {
                                                e.dataTransfer.effectAllowed = 'move';
                                                e.dataTransfer.setData(BOARD_TASK_MIME, encodeBoardTask(card));
                                            }}
                                            onDragOver={e => {
                                                if (hasDragType(e, RUNNING_CHIP_MIME)) {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    e.dataTransfer.dropEffect = 'copy';
                                                    if (cardDropTarget !== card.id) setCardDropTarget(card.id);
                                                }
                                            }}
                                            onDragLeave={() => {
                                                if (cardDropTarget === card.id) setCardDropTarget(null);
                                            }}
                                            onDrop={e => onDropToCard(card.id, e)}
                                        >
                                        <span className="dashboard-board-card-title">{card.title}</span>
                                        {card.summary ? (
                                            <span className="dashboard-board-card-summary" title={card.summary}>{card.summary}</span>
                                        ) : null}
                                        <div className="dashboard-board-card-instance-slot" data-empty={assignedChip ? 'false' : 'true'}>
                                            {assignedChip ? (
                                                <div
                                                    className="dashboard-board-card-instance"
                                                    data-state={assignedChip.state}
                                                    draggable
                                                    onDragStart={e => {
                                                        e.stopPropagation();
                                                        e.dataTransfer.effectAllowed = 'copy';
                                                        e.dataTransfer.setData(RUNNING_CHIP_MIME, encodeRunningChip(assignedChip));
                                                    }}
                                                    title={assignedChip.activity ? `${assignedChip.label} — ${assignedChip.activity}` : assignedChip.label}
                                                >
                                                    <span className="dashboard-board-card-instance-port">:{assignedChip.port}</span>
                                                    <span className="dashboard-board-card-instance-label">{assignedChip.label}</span>
                                                    <button
                                                        type="button"
                                                        className="dashboard-board-card-instance-detach"
                                                        onClick={() => void onDetachInstance(card.id)}
                                                        aria-label={`Detach :${assignedChip.port} from card`}
                                                        title="Detach instance"
                                                    >-</button>
                                                    {assignedChip.activity ? (
                                                        <span className="dashboard-board-card-instance-activity" title={assignedChip.activity}>{assignedChip.activity}</span>
                                                    ) : null}
                                                </div>
                                            ) : (
                                                <span className="dashboard-board-card-instance-empty">Drop a running instance here</span>
                                            )}
                                        </div>
                                        {card.persisted ? (
                                            <span
                                                className="dashboard-board-card-actions"
                                                data-open={movePopoverFor === card.id ? 'true' : 'false'}
                                            >
                                                <button
                                                    type="button"
                                                    className="dashboard-board-card-action"
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={() => setDialogCardId(card.id)}
                                                    aria-label="Open card details"
                                                    title="Open"
                                                ><CardActionIcon kind="open" /></button>
                                                <button
                                                    type="button"
                                                    className="dashboard-board-card-action"
                                                    onMouseDown={e => e.stopPropagation()}
                                                    onClick={() => setMovePopoverFor(prev => prev === card.id ? null : card.id)}
                                                    aria-haspopup="menu"
                                                    aria-expanded={movePopoverFor === card.id}
                                                    aria-label="Move card"
                                                    title="Move"
                                                ><CardActionIcon kind="move" /></button>
                                                <button
                                                    type="button"
                                                    className="dashboard-board-card-action"
                                                    data-danger="true"
                                                    onClick={() => void onDelete(card.id)}
                                                    aria-label="Delete card"
                                                    title="Delete"
                                                ><CardActionIcon kind="delete" /></button>
                                                {movePopoverFor === card.id && (
                                                    <div ref={popoverRef} className="dashboard-board-popover" role="menu">
                                                        {BOARD_LANES.map(l => (
                                                            <button
                                                                key={l.id}
                                                                type="button"
                                                                className={`dashboard-board-popover-item${l.id === card.lane ? ' is-current' : ''}`}
                                                                role="menuitem"
                                                                disabled={l.id === card.lane}
                                                                onClick={() => void onMove(card.id, l.id)}
                                                            >{l.label}{l.id === card.lane ? ' ✓' : ''}</button>
                                                        ))}
                                                    </div>
                                                )}
                                            </span>
                                        ) : null}
                                    </li>
                                    );
                                })}
                            </ul>
                            <div className="dashboard-board-lane-add">
                                {isComposing ? (
                                    <form
                                        className="dashboard-board-add-composer"
                                        onSubmit={e => { e.preventDefault(); void onAdd(lane.id); }}
                                    >
                                        <input
                                            autoFocus
                                            type="text"
                                            value={composerTitle}
                                            onChange={e => setComposerTitle(e.target.value)}
                                            placeholder={`New ${lane.label} task`}
                                            disabled={busy}
                                            aria-label={`New task for ${lane.label}`}
                                            onKeyDown={e => {
                                                if (e.key === 'Escape') {
                                                    setComposerLane(null);
                                                    setComposerTitle('');
                                                }
                                            }}
                                        />
                                        <button type="submit" disabled={busy || !composerTitle.trim()}>Add</button>
                                        <button
                                            type="button"
                                            onClick={() => { setComposerLane(null); setComposerTitle(''); }}
                                            aria-label="Cancel"
                                        >×</button>
                                    </form>
                                ) : (
                                    <button
                                        type="button"
                                        className="dashboard-board-add-trigger"
                                        onClick={() => { setComposerLane(lane.id); setComposerTitle(''); }}
                                    >+ Add task</button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            <DashboardBoardTaskDialog
                card={dialogCard}
                busy={dialogBusy}
                onClose={() => setDialogCardId(null)}
                onSave={onSaveCardDetails}
            />
        </section>
    );
}
