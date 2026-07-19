import { useCallback, useEffect, useState } from 'react';
import type { DockClient } from './dock-client';

type Props = { client: DockClient; active: boolean };

export function SettingsPromptSection({ client, active }: Props) {
    const [open, setOpen] = useState(false);
    const [content, setContent] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() => {
        if (!active || !open) return;
        let cancelled = false;
        client.get<{ content?: string }>('/api/prompt')
            .then((data) => {
                if (cancelled) return;
                const text = data?.content ?? '';
                setContent(text);
                setDraft(text);
            })
            .catch((err: unknown) => { if (!cancelled) setStatus(err instanceof Error ? err.message : String(err)); });
        return () => { cancelled = true; };
    }, [client, active, open]);

    const save = useCallback(() => {
        setStatus(null);
        client.put('/api/prompt', { content: draft })
            .then(() => {
                setContent(draft);
                setStatus('저장됨');
            })
            .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)));
    }, [client, draft]);

    return (
        <div className="dock-section">
            <button type="button" className="dock-section-header" onClick={() => setOpen((prev) => !prev)}>
                <span>시스템 프롬프트 편집</span>
                <span>{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <div className="dock-section-body">
                    {content === null && !status && <div className="dock-loading">로딩 중...</div>}
                    {content !== null && (
                        <>
                            <textarea
                                className="dock-prompt-editor"
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                            />
                            <div className="dock-row">
                                <button type="button" className="dock-mini-btn" disabled={draft === content} onClick={save}>저장</button>
                                {status && <span className="dock-dim">{status}</span>}
                            </div>
                        </>
                    )}
                    {content === null && status && <div className="dock-error">{status}</div>}
                </div>
            )}
        </div>
    );
}
