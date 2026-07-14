import { useCallback, useMemo, useRef, useState } from 'react';

export interface DirtyStore {
    isDirty: boolean;
    dirtyScope: string | null;
    markDirty(scope: string): void;
    markClean(scope?: string): void;
    confirmLeave(): boolean;
    registerActions(save: (() => Promise<void>) | null, discard: (() => void) | null): void;
    triggerSave(): Promise<void>;
}

export function useDirtyStore(): DirtyStore {
    const [dirtyScope, setDirtyScope] = useState<string | null>(null);
    const actionsRef = useRef<{ save: (() => Promise<void>) | null; discard: (() => void) | null }>({ save: null, discard: null });
    const markDirty = useCallback((scope: string) => setDirtyScope(scope), []);
    const markClean = useCallback((scope?: string) => {
        setDirtyScope((current) => !scope || current === scope ? null : current);
    }, []);
    const confirmLeave = useCallback(() => (
        dirtyScope === null
        || window.confirm('Discard your unsaved settings changes?')
    ), [dirtyScope]);
    const registerActions = useCallback((save: (() => Promise<void>) | null, discard: (() => void) | null) => {
        actionsRef.current = { save, discard };
    }, []);
    const triggerSave = useCallback(async () => {
        await actionsRef.current.save?.();
    }, []);

    return useMemo(() => ({
        isDirty: dirtyScope !== null,
        dirtyScope,
        markDirty,
        markClean,
        confirmLeave,
        registerActions,
        triggerSave,
    }), [confirmLeave, dirtyScope, markClean, markDirty, registerActions, triggerSave]);
}
