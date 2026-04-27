type SidebarRailProps = {
    onlineCount: number;
    onSelectInstances: () => void;
    onSelectPreview: () => void;
    onSelectActivity: () => void;
};

export function SidebarRail(props: SidebarRailProps) {
    return (
        <div className="sidebar-rail">
            <button className="rail-button is-active" type="button" onClick={props.onSelectInstances} aria-label="Instances">
                I
            </button>
            <button className="rail-button" type="button" onClick={props.onSelectPreview} aria-label="Preview">
                P
            </button>
            <button className="rail-button" type="button" onClick={props.onSelectActivity} aria-label="Activity">
                L
            </button>
            <button className="rail-button" type="button" aria-label="Settings">
                S
            </button>
            <div className="rail-spacer" />
            <span className="rail-status-dot" aria-label={`${props.onlineCount} online instances`} />
        </div>
    );
}
