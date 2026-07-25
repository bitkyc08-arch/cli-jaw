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
    const { openPanel } = useAppScope();

    useEffect(() => shortcuts.registerHandler('focusNotes', () => {
        openPanel({ type: 'notes', key: 'notes', title: 'Notes', keepAlive: true });
    }), [openPanel, shortcuts]);

    return null;
}
