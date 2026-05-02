import { useMemo } from 'react';
import type { DashboardInstance } from '../types';
import type { BoardView } from './board-view';
import { RUNNING_CHIP_MIME, deriveRunningChips, encodeRunningChip } from './running-chips';

type BoardLane = 'backlog' | 'ready' | 'active' | 'review' | 'done';

const LANES: { id: BoardLane; label: string; policy: string }[] = [
    { id: 'backlog', label: 'Backlog', policy: 'Options not yet committed' },
    { id: 'ready', label: 'Ready', policy: 'Pullable, clear enough to start' },
    { id: 'active', label: 'In Progress', policy: 'Current WIP, keep starts limited' },
    { id: 'review', label: 'Review', policy: 'Check output before delivery' },
    { id: 'done', label: 'Done', policy: 'Delivered or no longer active' },
];

type Props = {
    view: BoardView;
    onViewChange: (view: BoardView) => void;
    instances: DashboardInstance[];
    titlesByPort: Record<number, string>;
    busyPorts: Set<number>;
};

export function DashboardBoardSidebar(props: Props) {
    const runningChips = useMemo(
        () => deriveRunningChips(props.instances, props.titlesByPort, props.busyPorts),
        [props.instances, props.titlesByPort, props.busyPorts],
    );
    return (
        <nav className="dashboard-board-sidebar" aria-label="Board lanes">
            <header className="dashboard-board-sidebar-header">
                <span className="dashboard-board-sidebar-title">Board</span>
                <span className="dashboard-board-sidebar-count">{runningChips.length} running</span>
            </header>
            <section className="dashboard-board-sidebar-running" aria-label="Running instances">
                <div className="dashboard-board-sidebar-section-title">Running</div>
                {runningChips.length === 0 ? (
                    <p className="dashboard-board-sidebar-empty">No running instances</p>
                ) : (
                    <div className="dashboard-board-sidebar-running-list">
                        {runningChips.map(chip => (
                            <div
                                key={chip.port}
                                className="dashboard-board-running-chip"
                                data-state={chip.state}
                                draggable
                                onDragStart={event => {
                                    event.dataTransfer.effectAllowed = 'copy';
                                    event.dataTransfer.setData(RUNNING_CHIP_MIME, encodeRunningChip(chip));
                                }}
                                title={chip.activity ? `${chip.label} — ${chip.activity}` : chip.label}
                            >
                                <span className="dashboard-board-running-chip-port">:{chip.port}</span>
                                <span className="dashboard-board-running-chip-label">{chip.label}</span>
                                {chip.activity ? (
                                    <span className="dashboard-board-running-chip-activity">{chip.activity}</span>
                                ) : null}
                                <span className="dashboard-board-running-chip-state" data-state={chip.state}>
                                    {chip.state}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
            <div className="dashboard-board-sidebar-section-title">Lanes</div>
            <ul className="dashboard-board-sidebar-list">
                <li>
                    <button
                        type="button"
                        className={`dashboard-board-sidebar-item${props.view.kind === 'overall' ? ' is-active' : ''}`}
                        onClick={() => props.onViewChange({ kind: 'overall' })}
                        aria-pressed={props.view.kind === 'overall'}
                    >
                        <span>Overall</span>
                        <small>Five-column workflow</small>
                    </button>
                </li>
                {LANES.map(lane => (
                    <li key={lane.id}>
                        <button
                            type="button"
                            className={`dashboard-board-sidebar-item${props.view.kind === 'lane' && props.view.lane === lane.id ? ' is-active' : ''}`}
                            onClick={() => props.onViewChange({ kind: 'lane', lane: lane.id })}
                            aria-pressed={props.view.kind === 'lane' && props.view.lane === lane.id}
                        >
                            <span>{lane.label}</span>
                            <small>{lane.policy}</small>
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}

export type { BoardLane };
export { LANES as BOARD_LANES };
