import { PanelResizer } from '../panels/PanelResizer';

type SidebarResizeHandleProps = {
    width: number;
    onDelta: (delta: number) => void;
    onEnd: () => void;
    onDoubleClick: () => void;
};

export function SidebarResizeHandle(props: SidebarResizeHandleProps) {
    return (
        <PanelResizer
            direction="horizontal"
            onDelta={props.onDelta}
            onEnd={props.onEnd}
            onDoubleClick={props.onDoubleClick}
            className="sidebar-resize-handle"
            ariaLabel="Resize sidebar"
            ariaValueNow={props.width}
        />
    );
}
