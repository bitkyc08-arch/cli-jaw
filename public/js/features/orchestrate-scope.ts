export function shouldApplyOrcStateEvent(eventScope: unknown, currentScope: string): boolean {
    if (!eventScope || !currentScope) return true;
    return eventScope === 'all' || eventScope === currentScope;
}
