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
    const { openPanel, sidebarApi, selected, guardedSelectSession } = useAppScope();

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
            // A session is selected: focus its chat. Nothing else to do — the
            // chat is already the workspace.
            return;
        }
        // No selection: go to the first online instance's active session, or
        // failing that just focus the instance list.
        const firstOnline = api?.onlineInstances()[0];
        const sessionId = firstOnline ? api?.activeSessionFor(firstOnline.port) : null;
        if (firstOnline && sessionId) void guardedSelectSession(firstOnline.port, sessionId);
        else api?.focusInstances();
    }), [sidebarApi, selected, guardedSelectSession, shortcuts]);

    useEffect(() => {
        const cycle = (direction: 1 | -1): void => {
            const api = sidebarApi();
            const online = api?.onlineInstances() ?? [];
            if (online.length === 0) return;
            const currentIndex = selected
                ? online.findIndex((instance) => instance.port === selected.port)
                : -1;
            const nextIndex = currentIndex < 0
                ? (direction > 0 ? 0 : online.length - 1)
                : (currentIndex + direction + online.length) % online.length;
            const target = online[nextIndex]!;
            const sessionId = api?.activeSessionFor(target.port);
            if (sessionId) {
                // Land on a session: selection actually moves.
                void guardedSelectSession(target.port, sessionId);
            } else {
                // Sessionless instance: focus/expand its row without changing
                // `selected` (guardedSelectSession requires a sessionId).
                api?.focusInstanceRow(target.port);
            }
        };
        const unregisterPrevious = shortcuts.registerHandler('previousInstance', () => cycle(-1));
        const unregisterNext = shortcuts.registerHandler('nextInstance', () => cycle(1));
        return () => { unregisterPrevious(); unregisterNext(); };
    }, [sidebarApi, selected, guardedSelectSession, shortcuts]);

    return null;
}
