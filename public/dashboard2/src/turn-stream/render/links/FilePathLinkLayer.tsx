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
        let disposed = false;
        void import('../../../features/notes/notes-api.ts').then(module => module.fetchNotesInfo()).then(async ({ root }) => {
            const { normalizeNotesPath } = await import('../../../features/notes/notes-open-intent.ts');
            if (disposed) return;
            for (const link of host.querySelectorAll<HTMLElement>('[data-file-link]')) {
                const path = link.dataset['fileLink'];
                if (!path?.startsWith('/') || !normalizeNotesPath(path, root)) continue;
                const action = host.ownerDocument.createElement('button');
                action.type = 'button';
                action.className = 'd2-file-link-notes-action';
                action.dataset['notesOpenPath'] = path;
                action.setAttribute('aria-label', `${path} Notes에서 열기`);
                action.textContent = 'Notes에서 열기';
                link.after(action);
            }
        }).catch(() => { /* reveal/copy remains available */ });
        const activate = async (path: string): Promise<void> => {
            if (bridge?.filesystem.folder.nativeAvailable && bridge.filesystem.folder.native) {
                try { const result = await bridge.filesystem.folder.native.revealPath(path); if (result.ok) return; } catch { /* clipboard fallback */ }
            }
            try { await navigator.clipboard.writeText(path); setStatus('Path copied'); } catch { setStatus('Copy failed'); }
        };
        const activateTarget = (target: Element | null): boolean => {
            const notesAction = target?.closest<HTMLElement>('[data-notes-open-path]');
            const notesPath = notesAction?.dataset['notesOpenPath'];
            if (notesPath) {
                void import('../../../features/notes/notes-open-intent.ts').then(module => module.requestNotesOpen(notesPath));
                return true;
            }
            const link = target?.closest<HTMLElement>('[data-file-link]');
            const path = link?.dataset['fileLink'];
            if (path) { void activate(path); return true; }
            return false;
        };
        const click = (event: MouseEvent): void => { if (activateTarget(event.target as Element | null)) event.preventDefault(); };
        const keydown = (event: KeyboardEvent): void => { if ((event.key === 'Enter' || event.key === ' ') && activateTarget(event.target as Element | null)) event.preventDefault(); };
        host.addEventListener('click', click); host.addEventListener('keydown', keydown);
        return () => { disposed = true; host.removeEventListener('click', click); host.removeEventListener('keydown', keydown); host.querySelectorAll('[data-notes-open-path]').forEach(node => node.remove()); teardownFilePathLinks(host); };
    }, [bridge, host, revision]);
    return <span className="sr-only" role="status" aria-live="polite">{status}</span>;
}
