import { createRoot, type Root } from 'react-dom/client';
import { BoardPanel } from './BoardPanel.tsx';

let root: Root | null = null;

export function mountBoardPanelHarness(target: HTMLElement): () => void {
    root?.unmount();
    root = createRoot(target);
    root.render(<BoardPanel active />);
    return () => {
        root?.unmount();
        root = null;
    };
}
