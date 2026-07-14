import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useAppScope } from '../../state/scope.tsx';
import './panels.css';

export type DiffPanelProps = { active: boolean };
type DiffMode = 'unstaged' | 'staged';
type DiffPayload = { diff?: string; text?: string; canStage?: boolean; canUnstage?: boolean; actions?: string[] };
type DiffLine = { text: string; kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'; oldLine: number | null; newLine: number | null };

function diffText(payload: unknown): { text: string; canStage: boolean; canUnstage: boolean } {
    if (typeof payload === 'string') return { text: payload, canStage: false, canUnstage: false };
    if (!payload || typeof payload !== 'object') return { text: '', canStage: false, canUnstage: false };
    const body = payload as DiffPayload;
    return {
        text: typeof body.diff === 'string' ? body.diff : typeof body.text === 'string' ? body.text : '',
        canStage: body.canStage === true || body.actions?.includes('stage') === true,
        canUnstage: body.canUnstage === true || body.actions?.includes('unstage') === true,
    };
}

function parseDiff(text: string): DiffLine[] {
    let oldLine: number | null = null;
    let newLine: number | null = null;
    return text.split('\n').map((line) => {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            return { text: line, kind: 'hunk', oldLine: null, newLine: null };
        }
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
            return { text: line, kind: 'meta', oldLine: null, newLine: null };
        }
        if (line.startsWith('+')) return { text: line, kind: 'add', oldLine: null, newLine: newLine === null ? null : newLine++ };
        if (line.startsWith('-')) return { text: line, kind: 'del', oldLine: oldLine === null ? null : oldLine++, newLine: null };
        const result = { text: line, kind: 'context' as const, oldLine, newLine };
        if (oldLine !== null) oldLine++;
        if (newLine !== null) newLine++;
        return result;
    });
}

export function DiffPanel({ active }: DiffPanelProps): JSX.Element {
    const { selected } = useAppScope();
    const port = selected?.port ?? null;
    const [mode, setMode] = useState<DiffMode>('unstaged');
    const [text, setText] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [message, setMessage] = useState('');
    const [actions, setActions] = useState({ canStage: false, canUnstage: false });
    const lines = useMemo(() => parseDiff(text), [text]);

    const loadDiff = useCallback(async (): Promise<void> => {
        if (port === null) return;
        setStatus('loading');
        try {
            const response = await fetch(`/i/${port}/api/git/diff?mode=${mode}`, { cache: 'no-store' });
            const body = await response.text();
            let payload: unknown = body;
            if (body.trim()) {
                try { payload = JSON.parse(body) as unknown; } catch { /* Plain unified diff response. */ }
            }
            if (!response.ok) throw new Error(`Unable to load diff (${response.status})`);
            const parsed = diffText(payload);
            setText(parsed.text);
            setActions(parsed);
            setStatus('ready');
        } catch (error) {
            setMessage(error instanceof Error ? error.message : 'Unable to load diff');
            setStatus('error');
        }
    }, [mode, port]);

    useEffect(() => {
        if (active && port !== null) void loadDiff();
    }, [active, loadDiff, port]);

    async function mutate(kind: 'stage' | 'unstage'): Promise<void> {
        if (port === null) return;
        setStatus('loading');
        try {
            const response = await fetch(`/i/${port}/api/git/${kind}`, { method: 'POST' });
            if (!response.ok) throw new Error(`${kind === 'stage' ? 'Stage' : 'Unstage'} failed (${response.status})`);
            await loadDiff();
        } catch (error) {
            setMessage(error instanceof Error ? error.message : 'Git action failed');
            setStatus('error');
        }
    }

    return (
        <section className="d2-diff-panel" hidden={!active} aria-label="Git diff viewer">
            <header className="d2-panel-toolbar">
                <div className="d2-diff-toggle" role="group" aria-label="Diff mode">
                    {(['unstaged', 'staged'] as const).map((value) => <button key={value} type="button" className={mode === value ? 'is-active' : ''} aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</button>)}
                </div>
                {actions.canStage && mode === 'unstaged' ? <button type="button" onClick={() => void mutate('stage')}>Stage all</button> : null}
                {actions.canUnstage && mode === 'staged' ? <button type="button" onClick={() => void mutate('unstage')}>Unstage all</button> : null}
                <button type="button" onClick={() => void loadDiff()} disabled={port === null}>Refresh</button>
            </header>
            <div className="d2-diff-content">
                {port === null ? <div className="d2-panel-state">Select an instance to view its diff.</div> : null}
                {status === 'loading' ? <div className="d2-panel-state" role="status">Loading diff...</div> : null}
                {status === 'error' ? <div className="d2-panel-state is-error" role="alert">{message}</div> : null}
                {status === 'ready' && !text ? <div className="d2-panel-state">No {mode} changes.</div> : null}
                {status === 'ready' && text ? <pre className="d2-diff-lines">{lines.map((line, index) => <span key={index} className={`d2-diff-line is-${line.kind}`}><span className="d2-diff-line-number">{line.oldLine ?? ''}</span><span className="d2-diff-line-number">{line.newLine ?? ''}</span><code>{line.text || ' '}</code></span>)}</pre> : null}
            </div>
        </section>
    );
}
