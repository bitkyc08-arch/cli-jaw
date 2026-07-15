import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useDesktopBridge } from '../../providers/desktop-bridge-provider.tsx';
import { useManagerApi } from '../../providers/api-provider.tsx';
import { useAppScope } from '../../state/scope.tsx';
import { selectDiffTransport } from './diff-transport.ts';
import './panels.css';

type DiffMode = 'unstaged' | 'staged';
export type DiffPanelPayload = { repoRoot?: string; filePath?: string; mode?: DiffMode };
export type DiffPanelProps = { active: boolean; payload?: DiffPanelPayload };
type DiffFile = { path: string; status: string; insertions: number; deletions: number };
type DiffLine = { text: string; kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'; oldLine: number | null; newLine: number | null };

function parseDiff(text: string): DiffLine[] {
    let oldLine: number | null = null;
    let newLine: number | null = null;
    return text.split('\n').map((line) => {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text: line, kind: 'hunk', oldLine: null, newLine: null }; }
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return { text: line, kind: 'meta', oldLine: null, newLine: null };
        if (line.startsWith('+')) return { text: line, kind: 'add', oldLine: null, newLine: newLine === null ? null : newLine++ };
        if (line.startsWith('-')) return { text: line, kind: 'del', oldLine: oldLine === null ? null : oldLine++, newLine: null };
        const result = { text: line, kind: 'context' as const, oldLine, newLine };
        if (oldLine !== null) oldLine++;
        if (newLine !== null) newLine++;
        return result;
    });
}

export function DiffPanel({ active, payload = {} }: DiffPanelProps): JSX.Element {
    const { selected } = useAppScope();
    const api = useManagerApi();
    const bridge = useDesktopBridge();
    const port = selected?.port ?? null;
    const native = bridge.sourceControl.diff.nativeAvailable ? bridge.sourceControl.diff.native : null;
    const transport = useMemo(() => port === null ? null : selectDiffTransport(native, port), [native, port]);
    const [mode, setMode] = useState<DiffMode>(payload.mode ?? 'unstaged');
    const [repoRoot, setRepoRoot] = useState(payload.repoRoot ?? '');
    const [files, setFiles] = useState<DiffFile[]>([]);
    const [filePath, setFilePath] = useState(payload.filePath ?? '');
    const [text, setText] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [message, setMessage] = useState('');
    const requestGeneration = useRef(0);
    const lines = useMemo(() => parseDiff(text), [text]);

    useEffect(() => {
        const generation = ++requestGeneration.current;
        if (!active || port === null || !transport) return;
        if (payload.repoRoot) { setRepoRoot(payload.repoRoot); return; }
        setStatus('loading');
        void api.fetchInstances().then(async (instances) => {
            if (requestGeneration.current !== generation) return;
            const workingDir = instances.find((instance) => instance.port === port)?.workingDir;
            if (!workingDir) throw new Error('No working directory for the selected instance');
            const root = await transport.resolveRepoRoot(workingDir);
            if (requestGeneration.current !== generation) return;
            setRepoRoot(root);
        }).catch((error: unknown) => {
            if (requestGeneration.current !== generation) return;
            setStatus('error');
            setMessage(error instanceof Error ? error.message : 'Unable to resolve repository root');
        });
    }, [active, api, payload.repoRoot, port, transport]);

    const load = useCallback(async (): Promise<void> => {
        if (!transport || !repoRoot) return;
        const generation = ++requestGeneration.current;
        setStatus('loading');
        try {
            const nextFiles = await transport.getSummary(repoRoot, { mode });
            if (requestGeneration.current !== generation) return;
            const nextPath = nextFiles.some((file) => file.path === filePath) ? filePath : nextFiles[0]?.path ?? '';
            const nextText = nextPath ? await transport.getFileDiff(repoRoot, nextPath, { mode }) : '';
            if (requestGeneration.current !== generation) return;
            setFiles(nextFiles);
            setFilePath(nextPath);
            setText(nextText);
            setStatus('ready');
            setMessage('');
        } catch (error) {
            if (requestGeneration.current !== generation) return;
            setStatus('error');
            setMessage(error instanceof Error ? error.message : 'Unable to load diff');
        }
    }, [filePath, mode, repoRoot, transport]);

    useEffect(() => { if (active && repoRoot) void load(); }, [active, load, repoRoot]);

    async function selectFile(path: string): Promise<void> {
        if (!transport || !repoRoot) return;
        const generation = ++requestGeneration.current;
        setFilePath(path);
        setStatus('loading');
        try {
            const diff = await transport.getFileDiff(repoRoot, path, { mode });
            if (requestGeneration.current !== generation) return;
            setText(diff);
            setStatus('ready');
        } catch (error) {
            if (requestGeneration.current !== generation) return;
            setStatus('error');
            setMessage(error instanceof Error ? error.message : 'Unable to load file diff');
        }
    }

    async function mutate(): Promise<void> {
        if (!transport || !repoRoot || !filePath) return;
        try {
            await transport.runScmOperation(repoRoot, { kind: mode === 'staged' ? 'unstage' : 'stage', paths: [filePath] });
            await load();
        } catch (error) {
            setStatus('error');
            setMessage(error instanceof Error ? error.message : 'Source-control operation failed');
        }
    }

    return (
        <section className="d2-diff-panel" hidden={!active} aria-label="Git diff viewer">
            <header className="d2-panel-toolbar">
                <div className="d2-diff-toggle" role="group" aria-label="Diff mode">
                    {(['unstaged', 'staged'] as const).map((value) => <button key={value} type="button" className={mode === value ? 'is-active' : ''} aria-pressed={mode === value} onClick={() => setMode(value)}>{value}</button>)}
                </div>
                <button type="button" onClick={() => void mutate()} disabled={!filePath}>{mode === 'staged' ? 'Unstage file' : 'Stage file'}</button>
                <button type="button" onClick={() => void load()} disabled={!repoRoot}>Refresh</button>
            </header>
            <div className="d2-diff-content">
                {port === null ? <div className="d2-panel-state">Select an instance to view its diff.</div> : null}
                {port !== null && !repoRoot && status !== 'error' ? <div className="d2-panel-state" role="status">Resolving repository...</div> : null}
                {status === 'error' ? <div className="d2-panel-state is-error" role="alert">{message}</div> : null}
                {repoRoot ? <div className="d2-panel-path" title={repoRoot}>{repoRoot}</div> : null}
                <div className="d2-diff-file-list">{files.map((file) => <button key={file.path} type="button" className={file.path === filePath ? 'is-active' : ''} onClick={() => void selectFile(file.path)}>{file.status} {file.path}</button>)}</div>
                {status === 'ready' && !files.length ? <div className="d2-panel-state">No {mode} changes.</div> : null}
                {text ? <pre className="d2-diff-lines">{lines.map((line, index) => <span key={index} className={`d2-diff-line is-${line.kind}`}><span className="d2-diff-line-number">{line.oldLine ?? ''}</span><span className="d2-diff-line-number">{line.newLine ?? ''}</span><code>{line.text || ' '}</code></span>)}</pre> : null}
            </div>
        </section>
    );
}
