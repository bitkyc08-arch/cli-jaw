import { Component, type ErrorInfo, type ReactNode } from 'react';

type PanelErrorBoundaryProps = {
    label: string;
    children: ReactNode;
};

type PanelErrorBoundaryState = {
    error: Error | null;
};

/**
 * Containment boundary for panel bodies. A render error inside one panel
 * (e.g. the embedded Browser surface) must degrade to an inline error card,
 * not unmount the entire Manager app into a blank window.
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
    override state: PanelErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error(`[panel-error] ${this.props.label}:`, error, info.componentStack);
    }

    private readonly handleRetry = (): void => {
        this.setState({ error: null });
    };

    override render(): ReactNode {
        if (this.state.error) {
            return (
                <div className="panel-error-boundary" role="alert">
                    <div className="panel-error-title">{this.props.label} panel crashed</div>
                    <pre className="panel-error-message">{this.state.error.message}</pre>
                    <button type="button" className="panel-error-retry" onClick={this.handleRetry}>Retry</button>
                </div>
            );
        }
        return this.props.children;
    }
}
