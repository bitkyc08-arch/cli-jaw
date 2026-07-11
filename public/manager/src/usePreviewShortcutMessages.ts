import { useEffect } from 'react';
import { actionForShortcutEvent } from './manager-shortcuts';
import { allowedPreviewMessageOrigins, isAllowedPreviewMessage } from './preview-message-security';
import type { DashboardScanResult, DashboardShortcutAction, DashboardShortcutKeymap } from './types';

type PreviewShortcutMessageArgs = {
    enabled: boolean;
    data: DashboardScanResult | null;
    keymap: DashboardShortcutKeymap;
    onAction: (action: DashboardShortcutAction) => void;
};

export function usePreviewShortcutMessages(args: PreviewShortcutMessageArgs): void {
    useEffect(() => {
        const allowedOrigins = allowedPreviewMessageOrigins(args.data);
        function onPreviewShortcut(event: MessageEvent): void {
            if (!args.enabled) return;
            if (!isAllowedPreviewMessage(event, allowedOrigins)) return;
            const data = event.data as {
                type?: unknown;
                key?: unknown;
                code?: unknown;
                altKey?: unknown;
                ctrlKey?: unknown;
                metaKey?: unknown;
                shiftKey?: unknown;
            } | null;
            if (!data || data.type !== 'jaw-preview-shortcut') return;
            const synth = {
                key: data.key,
                code: data.code,
                altKey: !!data.altKey,
                ctrlKey: !!data.ctrlKey,
                metaKey: !!data.metaKey,
                shiftKey: !!data.shiftKey,
            } as unknown as KeyboardEvent;
            const action = actionForShortcutEvent(synth, args.keymap);
            if (action) args.onAction(action);
        }
        window.addEventListener('message', onPreviewShortcut);
        return () => window.removeEventListener('message', onPreviewShortcut);
    }, [args]);
}
