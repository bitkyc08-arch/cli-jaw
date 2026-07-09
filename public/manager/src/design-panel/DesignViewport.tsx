type DesignViewportProps = {
    previewUrl: string | null;
    zoom: number;
    /** Message shown when there is nothing to preview. */
    emptyMessage: string;
};

/**
 * Full-viewport sandboxed preview. The artifact is served by the manager
 * (`/api/dashboard/design/pages/:id/preview`) and rendered in an iframe with
 * a strict sandbox — never a webview and never any script bridge (186
 * guardrails). Wide artifacts scroll inside the iframe.
 */
export function DesignViewport(props: DesignViewportProps) {
    if (!props.previewUrl) {
        return (
            <div className="design-viewport design-viewport-empty">
                <span>{props.emptyMessage}</span>
            </div>
        );
    }
    const scale = props.zoom > 0 ? props.zoom : 1;
    return (
        <div className="design-viewport">
            <iframe
                className="design-viewport-frame"
                title="Design preview"
                src={props.previewUrl}
                sandbox=""
                style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: '0 0', width: `${100 / scale}%`, height: `${100 / scale}%` } : undefined}
            />
        </div>
    );
}
