import { BOARD_LANES, type BoardLane } from './DashboardBoardSidebar';
import type { BoardCard } from './board-view';
import type { RunningChip } from './running-chips';

type Props = {
    lane: BoardLane;
    cards: BoardCard[];
    runningChipByPort: Map<number, RunningChip>;
    onBackToOverall: () => void;
    onOpenCard: (id: string) => void;
};

function instanceLine(card: BoardCard, runningChipByPort: Map<number, RunningChip>): string {
    if (card.port === null) return 'no instance';
    const chip = runningChipByPort.get(card.port);
    return chip ? `:${chip.port} ${chip.label}` : `:${card.port}`;
}

export function BoardLaneDetailView(props: Props) {
    const lane = BOARD_LANES.find(candidate => candidate.id === props.lane);
    const title = lane?.label ?? 'Lane';
    const policy = lane?.policy ?? '';
    const withInstance = props.cards.filter(card => card.port !== null).length;
    const withoutInstance = props.cards.length - withInstance;

    return (
        <div className="dashboard-board-lane-detail-shell" data-lane={props.lane}>
            <aside className="dashboard-board-lane-detail-sidebar" aria-label={`${title} filters`}>
                <header>
                    <span>{title}</span>
                    <small>{policy}</small>
                </header>
                <div className="dashboard-board-lane-detail-counts">
                    <span><strong>{props.cards.length}</strong> all</span>
                    <span><strong>{withInstance}</strong> with instance</span>
                    <span><strong>{withoutInstance}</strong> no instance</span>
                </div>
                <button type="button" onClick={props.onBackToOverall}>Overall</button>
            </aside>
            <section className="dashboard-board-lane-detail-content" aria-label={`${title} cards`}>
                <header className="dashboard-board-lane-detail-header">
                    <div>
                        <h2>Board / {title}</h2>
                        <p>{props.lane === 'done' ? 'Done archive, shown as compact two-line rows.' : 'Lane detail, shown as compact rows for scan and reuse.'}</p>
                    </div>
                    <button type="button" onClick={props.onBackToOverall}>Close</button>
                </header>
                {props.cards.length === 0 ? (
                    <p className="dashboard-board-lane-detail-empty">No items in this lane</p>
                ) : (
                    <ul className="dashboard-board-compact-list">
                        {props.cards.map(card => (
                            <li key={card.id}>
                                <button
                                    type="button"
                                    className="dashboard-board-compact-row"
                                    onClick={() => props.onOpenCard(card.id)}
                                >
                                    <span className="dashboard-board-compact-row-title">{card.summary || card.title}</span>
                                    <span className="dashboard-board-compact-row-instance">{instanceLine(card, props.runningChipByPort)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
