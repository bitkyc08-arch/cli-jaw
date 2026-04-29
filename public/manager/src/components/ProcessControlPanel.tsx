import { useEffect, useState } from 'react';
import {
    adoptManagedProcesses,
    fetchProcessControlState,
    stopManagedProcesses,
} from '../api';
import type { DashboardProcessControlState } from '../types';

export function ProcessControlPanel() {
    const [state, setState] = useState<DashboardProcessControlState | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const managedCount = state?.managed.length || 0;

    useEffect(() => {
        void refresh();
    }, []);

    async function refresh(): Promise<void> {
        try {
            setState(await fetchProcessControlState());
        } catch (error) {
            setMessage((error as Error).message);
        }
    }

    async function run(label: string, fn: () => Promise<DashboardProcessControlState>): Promise<void> {
        setBusy(label);
        setMessage(null);
        try {
            const next = await fn();
            setState(next);
            setMessage(`${label} complete.`);
        } catch (error) {
            setMessage((error as Error).message);
        } finally {
            setBusy(null);
        }
    }

    function handleStopAll(): void {
        if (managedCount === 0) return;
        if (!window.confirm(`Stop ${managedCount} dashboard-managed server${managedCount === 1 ? '' : 's'}?`)) return;
        void run('Stop all managed', stopManagedProcesses);
    }

    return (
        <section className="process-control-panel" aria-label="Process control">
            <div className="process-control-header">
                <div>
                    <span>Process control</span>
                    <strong>{managedCount} managed</strong>
                </div>
                <button type="button" onClick={refresh} disabled={busy != null}>Refresh</button>
            </div>
            <div className="process-control-actions">
                <button type="button" onClick={handleStopAll} disabled={busy != null || managedCount === 0}>
                    Stop all managed
                </button>
                <button
                    type="button"
                    onClick={() => void run('Adopt/recover managed', adoptManagedProcesses)}
                    disabled={busy != null}
                >
                    Adopt/recover
                </button>
                <button type="button" disabled title={state?.unsupported.reason || 'Planned'}>
                    Force release port
                </button>
            </div>
            <div className="process-control-list">
                {state?.managed.map(entry => (
                    <div key={entry.port} className="process-control-row">
                        <span>:{entry.port}</span>
                        <strong>{entry.pid ? `pid ${entry.pid}` : 'pid n/a'}</strong>
                        <em>{entry.proof}</em>
                    </div>
                ))}
                {managedCount === 0 && <p>No dashboard-managed servers are registered.</p>}
            </div>
            {message && <p className="process-control-message">{message}</p>}
        </section>
    );
}
