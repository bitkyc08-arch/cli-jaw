import { type JSX } from 'react';

interface BoardPanelProps {
    active: boolean;
}

export function BoardPanel({ active }: BoardPanelProps): JSX.Element {
    return (
        <div className="d2-feature-panel d2-board-panel" style={{ display: active ? undefined : 'none' }}>
            <div className="d2-feature-panel-placeholder">
                <span className="d2-feature-panel-icon">Kanban columns</span>
                <h3>Board</h3>
                <p>Kanban board will appear here</p>
            </div>
        </div>
    );
}
