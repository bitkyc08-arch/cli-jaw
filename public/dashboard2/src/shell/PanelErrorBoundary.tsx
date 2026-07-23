import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

const loggedErrors = new WeakSet<Error>();

export interface PanelErrorBoundaryProps {
    panelId: string;
    guardedClosePanel(panelId: string): Promise<boolean>;
    children: ReactNode;
}

interface PanelErrorBoundaryState {
    failed: boolean;
    attempt: number;
}

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
    override state: PanelErrorBoundaryState = { failed: false, attempt: 0 };

    static getDerivedStateFromError(): Partial<PanelErrorBoundaryState> {
        return { failed: true };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        if (loggedErrors.has(error)) return;
        loggedErrors.add(error);
        console.error('[PanelErrorBoundary] panel render failed', error, info);
    }

    private retry = (): void => {
        this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
    };

    private close = (): void => {
        void this.props.guardedClosePanel(this.props.panelId);
    };

    override render(): ReactNode {
        if (this.state.failed) {
            return (
                <div className="d2-side-pane-placeholder" role="alert">
                    <span>패널을 표시할 수 없습니다.</span>
                    <button type="button" onClick={this.retry}>다시 시도</button>
                    <button type="button" onClick={this.close}>패널 닫기</button>
                </div>
            );
        }
        return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
}
