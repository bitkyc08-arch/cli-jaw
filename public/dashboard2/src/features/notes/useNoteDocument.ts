import { useCallback, useRef, useState } from 'react';
import { fetchNoteFile, saveNoteFile } from './notes-api';
import { isRevisionConflict } from './note-revisions';
import type { NoteConflictState, NoteFile } from './notes-types';

export type UseNoteDocumentResult = {
    file: NoteFile | null;
    content: string;
    dirty: boolean;
    loading: boolean;
    saving: boolean;
    error: string | null;
    conflict: NoteConflictState | null;
    setContent: (value: string) => void;
    load: (path: string) => Promise<void>;
    save: () => Promise<void>;
    reloadFromDisk: () => Promise<void>;
    overwrite: () => Promise<void>;
    clearConflict: () => void;
};

async function settlePendingEditorChanges(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
}

export function useNoteDocument(): UseNoteDocumentResult {
    const [file, setFile] = useState<NoteFile | null>(null);
    const [content, setContentState] = useState('');
    const [dirty, setDirty] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState<NoteConflictState | null>(null);
    const latestContentRef = useRef('');
    const dirtyRef = useRef(false);
    const savingRef = useRef(false);
    // 071: shared document-operation generation. A late completion of any op
    // (load/save/overwrite/conflict-recovery) applies nothing when it is no
    // longer current, so navigation always wins over in-flight A-state.
    const docOpGenerationRef = useRef(0);
    // Pending navigation target, recorded synchronously at load() entry.
    // save/overwrite refuse to dispatch while a load is in flight.
    const loadingPathRef = useRef<string | null>(null);
    const fileRef = useRef(file);
    fileRef.current = file;

    const load = useCallback(async (path: string): Promise<void> => {
        const generation = ++docOpGenerationRef.current;
        loadingPathRef.current = path;
        setLoading(true);
        setError(null);
        setConflict(null);
        const isCurrent = () => generation === docOpGenerationRef.current;
        try {
            const next = await fetchNoteFile(path);
            if (!isCurrent()) return;
            loadingPathRef.current = null;
            setFile(next);
            latestContentRef.current = next.content;
            dirtyRef.current = false;
            setContentState(next.content);
            setDirty(false);
        } catch (loadError) {
            if (!isCurrent()) return;
            loadingPathRef.current = null;
            setError(loadError instanceof Error ? loadError.message : 'Unable to load note');
        } finally {
            if (isCurrent()) setLoading(false);
        }
    }, []);

    function setContent(value: string): void {
        latestContentRef.current = value;
        dirtyRef.current = true;
        setContentState(value);
        setDirty(true);
    }

    const save = useCallback(async (): Promise<void> => {
        const preGeneration = docOpGenerationRef.current;
        const prePath = fileRef.current?.path ?? null;
        await settlePendingEditorChanges();
        if (preGeneration !== docOpGenerationRef.current) return;
        if ((fileRef.current?.path ?? null) !== prePath) return;
        if (loadingPathRef.current !== null) return;
        if (!file || !dirtyRef.current || savingRef.current) return;
        const generation = ++docOpGenerationRef.current;
        const contentSnapshot = latestContentRef.current;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        setConflict(null);
        const isCurrent = () => generation === docOpGenerationRef.current;
        try {
            const saved = await saveNoteFile({ path: file.path, content: contentSnapshot, baseRevision: file.revision });
            if (!isCurrent()) return;
            setFile(saved);
            if (latestContentRef.current === contentSnapshot) {
                latestContentRef.current = saved.content;
                dirtyRef.current = false;
                setContentState(saved.content);
                setDirty(false);
            }
        } catch (saveError) {
            if (!isCurrent()) return;
            if (isRevisionConflict(saveError)) {
                let remoteRevision = file.revision;
                try {
                    const remote = await fetchNoteFile(file.path);
                    if (!isCurrent()) return;
                    remoteRevision = remote.revision;
                    setFile(remote);
                } catch {
                    if (!isCurrent()) return;
                    remoteRevision = file.revision;
                }
                setConflict({
                    localContent: contentSnapshot,
                    remoteRevision,
                    message: saveError instanceof Error ? saveError.message : 'Note revision conflict',
                });
            } else {
                setError(saveError instanceof Error ? saveError.message : 'Unable to save note');
            }
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }, [file]);

    const reloadFromDisk = useCallback(async (): Promise<void> => {
        if (file) await load(file.path);
    }, [file, load]);

    const overwrite = useCallback(async (): Promise<void> => {
        const preGeneration = docOpGenerationRef.current;
        const prePath = fileRef.current?.path ?? null;
        await settlePendingEditorChanges();
        if (preGeneration !== docOpGenerationRef.current) return;
        if ((fileRef.current?.path ?? null) !== prePath) return;
        if (loadingPathRef.current !== null) return;
        if (!file || savingRef.current) return;
        const generation = ++docOpGenerationRef.current;
        const contentSnapshot = latestContentRef.current;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        const isCurrent = () => generation === docOpGenerationRef.current;
        try {
            const saved = await saveNoteFile({ path: file.path, content: contentSnapshot });
            if (!isCurrent()) return;
            setFile(saved);
            if (latestContentRef.current === contentSnapshot) {
                latestContentRef.current = saved.content;
                dirtyRef.current = false;
                setContentState(saved.content);
                setDirty(false);
            }
            setConflict(null);
        } catch (overwriteError) {
            if (!isCurrent()) return;
            setError(overwriteError instanceof Error ? overwriteError.message : 'Unable to overwrite note');
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }, [file]);

    return {
        file, content, dirty, loading, saving, error, conflict, setContent, load, save,
        reloadFromDisk, overwrite, clearConflict: () => setConflict(null),
    };
}
