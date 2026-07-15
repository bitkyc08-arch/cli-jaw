import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { loadEmployeeSurface, type EmployeeSurfaceData } from './employees-api.ts';
import './employees.css';

export interface EmployeesPanelProps {
    active: boolean;
    port: number;
}

export const EMPLOYEES_POLL_INTERVAL_MS = 5_000;

function relativeTime(timestamp: number | null): string {
    if (!timestamp) return 'No progress yet';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ago`;
}

export function EmployeesPanel({ active, port }: EmployeesPanelProps): JSX.Element {
    const [data, setData] = useState<EmployeeSurfaceData | null>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [error, setError] = useState('');
    const requestGeneration = useRef(0);

    const refresh = useCallback(async (signal: AbortSignal, showLoading: boolean): Promise<void> => {
        const generation = ++requestGeneration.current;
        if (showLoading) {
            setStatus('loading');
            setData(null);
        }
        setError('');
        try {
            const next = await loadEmployeeSurface(port, { signal });
            if (signal.aborted || requestGeneration.current !== generation) return;
            setData(next);
            setStatus('ready');
        } catch (cause) {
            if (signal.aborted || requestGeneration.current !== generation) return;
            setError(cause instanceof Error ? cause.message : 'Unable to load employees');
            setStatus('error');
        }
    }, [port]);

    useEffect(() => {
        requestGeneration.current += 1;
        setData(null);
        setStatus('loading');
        if (!active) return;
        let controller: AbortController | null = null;
        let timer: number | undefined;
        const stop = (): void => {
            if (timer !== undefined) window.clearInterval(timer);
            timer = undefined;
            controller?.abort();
            controller = null;
            requestGeneration.current += 1;
        };
        const run = (showLoading: boolean): void => {
            controller?.abort();
            controller = new AbortController();
            void refresh(controller.signal, showLoading);
        };
        const start = (showLoading: boolean): void => {
            if (document.hidden) return;
            run(showLoading);
            timer = window.setInterval(() => run(false), EMPLOYEES_POLL_INTERVAL_MS);
        };
        const onVisibilityChange = (): void => {
            stop();
            if (!document.hidden) start(true);
        };
        start(true);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            stop();
        };
    }, [active, port, refresh]);

    return (
        <section className="d2-employees-panel" hidden={!active} aria-label="Employees">
            <header className="d2-employees-header">
                <div><strong>Employees</strong><span>Port {port}</span></div>
                {data ? <span>{data.rows.length} total</span> : null}
            </header>
            {status === 'loading' ? <div className="d2-employees-state" role="status">Loading employees...</div> : null}
            {status === 'error' ? <div className="d2-employees-state is-error" role="alert">{error}</div> : null}
            {data?.warnings.map((warning) => <div key={warning} className="d2-employees-warning" role="status">{warning}</div>)}
            {status === 'ready' && data?.rows.length === 0 ? <div className="d2-employees-state">No employees configured.</div> : null}
            {data?.rows.length ? (
                <ul className="d2-employees-list">
                    {data.rows.map((employee) => (
                        <li key={employee.id} className="d2-employee-row">
                            <div className="d2-employee-row-main">
                                <strong>{employee.name}</strong>
                                <span className={`d2-employee-state is-${employee.active ? 'active' : 'idle'}`}>{employee.state}</span>
                            </div>
                            <div className="d2-employee-meta">{employee.role || `${employee.cli}${employee.model ? ` · ${employee.model}` : ''}`}</div>
                            <div className="d2-employee-task">{employee.taskPreview ?? 'No current task'}</div>
                            <div className="d2-employee-progress">
                                <span>{relativeTime(employee.progressUpdatedAt)}</span>
                                {employee.attention ? <span className="is-attention" title={employee.attention.message}>{employee.attention.kind}</span> : null}
                            </div>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
