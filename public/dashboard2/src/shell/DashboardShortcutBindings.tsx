/*
 * Binds global shortcut actions to real behavior.
 *
 * This lives BELOW AppScopeProvider on purpose. ManagerShortcutProvider sits
 * above AppScopeProvider in main.tsx, so the provider itself cannot reach app
 * scope; the binding has to happen in a component that can see both contexts.
 *
 * Actions without a binding here are deliberately unbound. The shortcut
 * provider passes their keys through instead of swallowing them, so an unbound
 * action costs the user nothing.
 */
import { useEffect, type JSX } from 'react';
import { useManagerShortcuts } from '../providers/shortcut-provider.tsx';
import { useAppScope } from '../state/scope.tsx';

export function DashboardShortcutBindings(): JSX.Element | null {
    const shortcuts = useManagerShortcuts();
    const { openPanel, sidebarApi, selected, guardedSelectSession, guardedSetWorkspaceMode } = useAppScope();

    useEffect(() => shortcuts.registerHandler('focusNotes', () => {
        openPanel({ type: 'notes', key: 'notes', title: 'Notes', keepAlive: true });
    }), [openPanel, shortcuts]);

    // wp9 — the four instance shortcuts, ported from the legacy manager
    // (manager-shortcut-runner.ts:25-49) to dashboard2's surfaces. The sidebar
    // exposes its local mode/instances through the scope's sidebarApi.
    useEffect(() => shortcuts.registerHandler('focusInstances', () => {
        sidebarApi()?.focusInstances();
    }), [sidebarApi, shortcuts]);

    useEffect(() => shortcuts.registerHandler('focusActiveSession', () => {
        const api = sidebarApi();
        if (selected) {
            // A session is selected: switch to the chat workspace (Settings may
            // be showing), then focus the active chat's composer.
            void guardedSetWorkspaceMode('chat').then(() => {
                requestAnimationFrame(() => {
                    document.querySelector<HTMLElement>('.d2-chat-composer-slot textarea, [data-testid="chat-view"] textarea')
                        ?.focus();
                });
            });
            return;
        }
        // No selection: go to the first online instance's active session, or
        // failing that just focus the instance list.
        const firstOnline = api?.orderedInstances().find((instance) => instance.online);
        if (!firstOnline) { api?.focusInstances(); return; }
        void api?.ensureSessions(firstOnline.port).then(() => {
            const sessionId = api?.activeSessionFor(firstOnline.port);
            if (sessionId) void guardedSelectSession(firstOnline.port, sessionId);
            else api?.focusInstanceRow(firstOnline.port);
        });
    }), [sidebarApi, selected, guardedSelectSession, guardedSetWorkspaceMode, shortcuts]);

    useEffect(() => {
        const cycle = (direction: 1 | -1): void => {
            const api = sidebarApi();
            // Cycle the full ordered list (legacy filtered-list semantics).
            const list = api?.orderedInstances() ?? [];
            if (list.length === 0) return;
            const currentIndex = selected
                ? list.findIndex((instance) => instance.port === selected.port)
                : -1;
            const nextIndex = currentIndex < 0
                ? (direction > 0 ? 0 : list.length - 1)
                : (currentIndex + direction + list.length) % list.length;
            const target = list[nextIndex]!;
            if (!target.online) {
                // An offline instance has no session to open; focus its row.
                api?.focusInstanceRow(target.port);
                return;
            }
            // Load sessions first so activeSessionFor has the active session,
            // then select it; otherwise focus the row without changing selected.
            void api?.ensureSessions(target.port).then(() => {
                const sessionId = api?.activeSessionFor(target.port);
                if (sessionId) void guardedSelectSession(target.port, sessionId);
                else api?.focusInstanceRow(target.port);
            });
        };
        const unregisterPrevious = shortcuts.registerHandler('previousInstance', () => cycle(-1));
        const unregisterNext = shortcuts.registerHandler('nextInstance', () => cycle(1));
        return () => { unregisterPrevious(); unregisterNext(); };
    }, [sidebarApi, selected, guardedSelectSession, shortcuts]);

    return null;
}
