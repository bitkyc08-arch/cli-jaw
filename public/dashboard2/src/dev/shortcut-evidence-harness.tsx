import { useEffect, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardRegistry } from '../../../../src/manager/types.ts';
import { ManagerPreferencesProvider } from '../providers/preferences-provider.tsx';
import { ManagerShortcutProvider, useManagerShortcuts } from '../providers/shortcut-provider.tsx';

declare global {
    interface Window {
        __jawShortcutEvidence?: { counts: Record<'focusNotes' | 'focusInstances', number> };
    }
}

let root: Root | null = null;
const registry = {
    ui: {
        uiTheme: 'dark', locale: 'en', dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: { focusNotes: 'Meta+N', focusInstances: 'Meta+K' },
        chatLinkPreviewsEnabled: false,
    },
} as unknown as DashboardRegistry;
const client = { load: async () => ({ registry, status: {} }), patch: async () => ({ registry, status: {} }) };

function Probe(): JSX.Element {
    const shortcuts = useManagerShortcuts();
    const [, rerender] = useState(0);
    useEffect(() => {
        const evidence = window.__jawShortcutEvidence ?? { counts: { focusNotes: 0, focusInstances: 0 } };
        window.__jawShortcutEvidence = evidence;
        const unregisterNotes = shortcuts.registerHandler('focusNotes', () => { evidence.counts.focusNotes += 1; rerender(value => value + 1); });
        const unregisterInstances = shortcuts.registerHandler('focusInstances', () => { evidence.counts.focusInstances += 1; rerender(value => value + 1); });
        return () => { unregisterNotes(); unregisterInstances(); };
    }, [shortcuts]);
    return (
        <main data-testid="shortcut-harness">
            <div data-surface="plain" tabIndex={0}>Plain surface</div>
            <textarea data-surface="composer" aria-label="Composer" />
            <div data-surface="notes-editable" contentEditable suppressContentEditableWarning>Notes editable</div>
            <input data-surface="settings-field" aria-label="Settings field" />
            <div className="xterm" data-surface="xterm-terminal" tabIndex={0}>Terminal</div>
            <input data-surface="browser-url" aria-label="Browser URL" />
            <button data-surface="code-history" type="button">Code history</button>
            <textarea data-surface="code-composer" aria-label="Code composer" />
            <button data-surface="code-permission" type="button">Code permission</button>
            <iframe data-surface="iframe" title="Preview frame" srcDoc="<button id='frame-target'>Frame target</button>" />
        </main>
    );
}

export function mountShortcutEvidenceHarness(target: HTMLElement): void {
    root?.unmount();
    window.__jawShortcutEvidence = { counts: { focusNotes: 0, focusInstances: 0 } };
    root = createRoot(target);
    root.render(<ManagerPreferencesProvider client={client}><ManagerShortcutProvider><Probe /></ManagerShortcutProvider></ManagerPreferencesProvider>);
}
