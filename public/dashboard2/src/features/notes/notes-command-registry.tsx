import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type NoteCommand = {
    id: string;
    section: string;
    label: string;
    keywords?: string[];
    shortcut?: string;
    disabled?: boolean;
    disabledReason?: string;
    run: () => void | Promise<void>;
};

type NotesCommandRegistry = {
    commands: NoteCommand[];
    register: (commands: NoteCommand[]) => () => void;
};

const NotesCommandRegistryContext = createContext<NotesCommandRegistry | null>(null);

export function NotesCommandProvider(props: { children: ReactNode }) {
    const [commandsById, setCommandsById] = useState<Map<string, NoteCommand>>(() => new Map());

    const register = useCallback((commands: NoteCommand[]) => {
        const incoming = new Map(commands.map(command => [command.id, command]));
        setCommandsById(previous => {
            const next = new Map(previous);
            for (const command of commands) {
                const existing = next.get(command.id);
                if (existing && existing !== command) {
                    console.warn(`[notes-command-palette] duplicate command id: ${command.id}`);
                }
                next.set(command.id, command);
            }
            return next;
        });

        return () => {
            setCommandsById(previous => {
                const next = new Map(previous);
                for (const [id, command] of incoming) {
                    if (next.get(id) === command) next.delete(id);
                }
                return next;
            });
        };
    }, []);

    const commands = useMemo(() => [...commandsById.values()].sort((a, b) => {
        const section = a.section.localeCompare(b.section);
        return section !== 0 ? section : a.label.localeCompare(b.label);
    }), [commandsById]);

    const value = useMemo(() => ({ commands, register }), [commands, register]);
    return <NotesCommandRegistryContext.Provider value={value}>{props.children}</NotesCommandRegistryContext.Provider>;
}

export function useNoteCommands(): NoteCommand[] {
    const registry = useContext(NotesCommandRegistryContext);
    if (!registry) throw new Error('useNoteCommands must be used inside NotesCommandProvider');
    return registry.commands;
}

export function useRegisterNoteCommands(commands: NoteCommand[], active = true): void {
    const registry = useContext(NotesCommandRegistryContext);
    if (!registry) throw new Error('useRegisterNoteCommands must be used inside NotesCommandProvider');
    const register = registry.register;
    useEffect(() => {
        if (!active || commands.length === 0) return undefined;
        return register(commands);
    }, [active, commands, register]);
}
