import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    type JSX,
    type PropsWithChildren,
} from 'react';
import {
    SHORTCUT_ACTIONS,
    usePreferences,
    type ShortcutAction,
    type ShortcutKeymap,
} from './preferences-provider.tsx';

export type ShortcutSource =
    | 'dom'
    | 'preview-iframe'
    | 'electron-menu'
    | 'electron-webcontents';

export type ShortcutHandler = (source: ShortcutSource) => void;

export interface ManagerShortcuts {
    dispatch(action: ShortcutAction, source: ShortcutSource): void;
    registerHandler(action: ShortcutAction, callback: ShortcutHandler): () => void;
}

interface RegisteredHandler {
    callback: ShortcutHandler;
    registrationOrder: number;
}

const HANDLER_PRIORITY = ['registrationOrder'] as const;
const ShortcutContext = createContext<ManagerShortcuts | null>(null);

type ParsedShortcut = {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
};

function normalizeKey(value: string): string {
    const lower = value.trim().toLowerCase();
    if (lower === 'space') return ' ';
    return lower;
}

function parseShortcut(raw: string): ParsedShortcut | null {
    const parsed: ParsedShortcut = {
        key: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
    };
    for (const part of raw.split('+').map((value) => value.trim()).filter(Boolean)) {
        const token = part.toLowerCase();
        if (token === 'alt' || token === 'option') parsed.altKey = true;
        else if (token === 'ctrl' || token === 'control') parsed.ctrlKey = true;
        else if (token === 'meta' || token === 'cmd' || token === 'command') parsed.metaKey = true;
        else if (token === 'shift') parsed.shiftKey = true;
        else parsed.key = normalizeKey(part);
    }
    return parsed.key ? parsed : null;
}

function eventKey(event: KeyboardEvent): string {
    if (event.altKey && event.code.startsWith('Key')) {
        return event.code.slice(3).toLowerCase();
    }
    return normalizeKey(event.key);
}

function shortcutMatches(event: KeyboardEvent, raw: string): boolean {
    const shortcut = parseShortcut(raw);
    return shortcut !== null
        && event.altKey === shortcut.altKey
        && event.ctrlKey === shortcut.ctrlKey
        && event.metaKey === shortcut.metaKey
        && event.shiftKey === shortcut.shiftKey
        && eventKey(event) === shortcut.key;
}

function actionForEvent(event: KeyboardEvent, keymap: ShortcutKeymap): ShortcutAction | null {
    return SHORTCUT_ACTIONS.find((action) => shortcutMatches(event, keymap[action])) ?? null;
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    return tag === 'input'
        || tag === 'textarea'
        || Boolean(target.closest('[contenteditable="true"]'));
}

export function ManagerShortcutProvider(props: PropsWithChildren): JSX.Element {
    const { shortcuts } = usePreferences();
    const handlersRef = useRef(new Map<ShortcutAction, RegisteredHandler[]>());
    const nextRegistrationOrder = useRef(0);

    const dispatch = useCallback((action: ShortcutAction, source: ShortcutSource): void => {
        // preview-iframe remains a typed source; origin validation is added with the iframe bridge.
        const handlers = handlersRef.current.get(action) ?? [];
        const selected = [...handlers].sort((left, right) => {
            for (const priority of HANDLER_PRIORITY) {
                const difference = left[priority] - right[priority];
                if (difference !== 0) return difference;
            }
        return 0;
        })[0];
        selected?.callback(source);
    }, []);

    /*
     * Whether ANY handler is registered for this action right now.
     *
     * Read from the ref at event time, never captured in a closure, so a handler
     * registered or removed after the listener was installed is still seen
     * correctly.
     */
    const hasHandler = useCallback((action: ShortcutAction): boolean => (
        (handlersRef.current.get(action)?.length ?? 0) > 0
    ), []);

    const registerHandler = useCallback((
        action: ShortcutAction,
        callback: ShortcutHandler,
    ): (() => void) => {
        const entry: RegisteredHandler = {
            callback,
            registrationOrder: nextRegistrationOrder.current++,
        };
        const handlers = handlersRef.current.get(action) ?? [];
        handlers.push(entry);
        handlersRef.current.set(action, handlers);
        return () => {
            const current = handlersRef.current.get(action);
            if (!current) return;
            const remaining = current.filter((candidate) => candidate !== entry);
            if (remaining.length > 0) handlersRef.current.set(action, remaining);
            else handlersRef.current.delete(action);
        };
    }, []);

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent): void {
            if (event.isComposing || event.keyCode === 229) return;
            if (!shortcuts.shortcutsEnabled || isEditableTarget(event.target)) return;
            const action = actionForEvent(event, shortcuts.keymap);
            if (!action) return;
            /*
             * Do not steal a key we cannot act on.
             *
             * Every action ships a default chord, but a chord with no registered
             * handler used to be preventDefault()-ed anyway and then dispatched
             * into an empty handler map. The result was worse than a missing
             * feature: the app swallowed Alt+I/J/K/N/P and Meta+K/Meta+N and did
             * nothing, blocking the browser and OS defaults too. Let those
             * through until something actually handles them.
             */
            if (!hasHandler(action)) return;
            event.preventDefault();
            dispatch(action, 'dom');
        }
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [dispatch, hasHandler, shortcuts.keymap, shortcuts.shortcutsEnabled]);

    const value = useMemo<ManagerShortcuts>(() => ({ dispatch, registerHandler }), [
        dispatch,
        registerHandler,
    ]);

    return (
        <ShortcutContext.Provider value={value}>
            {props.children}
        </ShortcutContext.Provider>
    );
}

export function useManagerShortcuts(): ManagerShortcuts {
    const shortcuts = useContext(ShortcutContext);
    if (!shortcuts) {
        throw new Error('useManagerShortcuts must be used inside ManagerShortcutProvider');
    }
    return shortcuts;
}
