import { useLayoutEffect, useState, type ReactElement } from 'react';
import { useOptionalDesktopBridge } from '../../../providers/desktop-bridge-provider.tsx';
import { linkifyFilePaths, teardownFilePathLinks } from './file-path-linkifier.ts';

export function FilePathLinkLayer({ host, revision }: { host: HTMLElement | null; revision: string }): ReactElement {
    // optional: without a bridge provider (web/tests) we degrade to clipboard
    const bridge = useOptionalDesktopBridge();
    const [status, setStatus] = useState('');
    // useLayoutEffect: the text-node mutation must land in the same commit,
    // BEFORE paint and before the virtualizer's ResizeObserver measurement —
    // a passive-effect mutation re-heights rows after the anchor read and
    // accumulates prepend anchor drift (044 browser gate regression).
    useLayoutEffect(() => {
        if (!host) return;
        linkifyFilePaths(host);
        const activate = async (path: string): Promise<void> => {
            if (bridge?.filesystem.folder.nativeAvailable && bridge.filesystem.folder.native) {
                try { const result = await bridge.filesystem.folder.native.revealPath(path); if (result.ok) return; } catch { /* clipboard fallback */ }
            }
            try { await navigator.clipboard.writeText(path); setStatus('Path copied'); } catch { setStatus('Copy failed'); }
        };
        const click = (event: MouseEvent): void => { const link = (event.target as Element | null)?.closest<HTMLElement>('[data-file-link]'); const path = link?.dataset['fileLink']; if (path) { event.preventDefault(); void activate(path); } };
        const keydown = (event: KeyboardEvent): void => { if (event.key !== 'Enter' && event.key !== ' ') return; const link = (event.target as Element | null)?.closest<HTMLElement>('[data-file-link]'); const path = link?.dataset['fileLink']; if (path) { event.preventDefault(); void activate(path); } };
        host.addEventListener('click', click); host.addEventListener('keydown', keydown);
        return () => { host.removeEventListener('click', click); host.removeEventListener('keydown', keydown); teardownFilePathLinks(host); };
    }, [bridge, host, revision]);
    return <span className="sr-only" role="status" aria-live="polite">{status}</span>;
}
