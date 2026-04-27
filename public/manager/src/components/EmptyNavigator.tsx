/* 10.6.10 — Empty state for the InstanceNavigator.
 *
 * Rendered by App.tsx when the scan returns zero instances and no hidden ones.
 * Renders inside the navigator scroll area so the rest of the shell layout
 * stays untouched. Pure presentational; the only side effect is a soft scroll
 * into the scan-range control on click of the secondary action.
 */

type EmptyNavigatorProps = {
    rangeFrom: number;
    rangeTo: number;
};

function scrollToScanRange(): void {
    const target = document.querySelector('.scan-range-control');
    if (target instanceof HTMLElement) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const firstInput = target.querySelector('input');
        if (firstInput instanceof HTMLInputElement) firstInput.focus();
    }
}

export function EmptyNavigator(props: EmptyNavigatorProps) {
    return (
        <div className="empty-navigator" role="status" aria-live="polite">
            <p className="empty-navigator-headline">No Jaw instances detected on the scanned range.</p>
            <p className="empty-navigator-subline">
                Currently scanning ports {props.rangeFrom}–{props.rangeTo}. Try widening the range, or start a Jaw with the command below.
            </p>
            <code className="empty-navigator-code" aria-label="Suggested command">
                jaw serve --port {props.rangeFrom}
            </code>
            <button
                type="button"
                className="empty-navigator-action"
                onClick={scrollToScanRange}
            >
                Adjust scan range ↑
            </button>
        </div>
    );
}
