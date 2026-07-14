import { useState, type ReactElement } from 'react';
import { usePreferences } from '../../../providers/preferences-provider.tsx';
import type { RenderIdentity } from '../parse-coalescer.ts';

const MAX_ROWS = 800;

export type DiffRowKind = 'file' | 'hunk' | 'add' | 'delete' | 'context' | 'meta';
export interface DiffRow { text: string; kind: DiffRowKind }

export function parseUnifiedDiffRows(source: string): { rows: DiffRow[]; omitted: number } {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    return {
        rows: lines.slice(0, MAX_ROWS).map(text => ({ text, kind: diffRowKind(text) })),
        omitted: Math.max(0, lines.length - MAX_ROWS),
    };
}

function diffRowKind(line: string): DiffRowKind {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'file';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'delete';
    if (line.startsWith(' ')) return 'context';
    return 'meta';
}

export function UnifiedDiffSegment({ source }: { source: string; identity?: RenderIdentity }): ReactElement {
    const { locale } = usePreferences();
    const ko = locale.locale === 'ko';
    const [copied, setCopied] = useState(false);
    const parsed = parseUnifiedDiffRows(source);
    const copy = async (): Promise<void> => {
        try { await navigator.clipboard.writeText(source); setCopied(true); }
        catch { setCopied(false); }
    };
    return (
        <section className="d2-diff" role="region" aria-label={ko ? '통합 diff' : 'Unified diff'}>
            <button type="button" className="d2-diff__copy" onClick={() => void copy()}>
                {copied ? (ko ? '복사됨' : 'Copied') : (ko ? 'diff 복사' : 'Copy diff')}
            </button>
            <div className="d2-diff__rows">
                {parsed.rows.map((row, index) => <div key={index} className={`d2-diff__row d2-diff__row--${row.kind}`} data-diff-kind={row.kind}><span className="d2-diff__line-number" aria-hidden="true">{row.kind === 'file' || row.kind === 'hunk' ? '' : index + 1}</span><span className="d2-diff__code">{row.text || ' '}</span></div>)}
                {parsed.omitted > 0 ? <div className="d2-diff__omitted" data-diff-kind="omitted">{/* TODO(r3-integrator): lift diff.omitted into renderCopy. */}{ko ? `${parsed.omitted}줄 생략됨` : `${parsed.omitted} lines omitted`}</div> : null}
            </div>
        </section>
    );
}
