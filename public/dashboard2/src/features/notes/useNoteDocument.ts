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

    const load = useCallback(async (path: string): Promise<void> => {
        setLoading(true);
        setError(null);
        setConflict(null);
        try {
            const next = await fetchNoteFile(path);
            setFile(next);
            latestContentRef.current = next.content;
            dirtyRef.current = false;
            setContentState(next.content);
            setDirty(false);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Unable to load note');
        } finally {
            setLoading(false);
        }
    }, []);

    function setContent(value: string): void {
        latestContentRef.current = value;
        dirtyRef.current = true;
        setContentState(value);
        setDirty(true);
    }

    const save = useCallback(async (): Promise<void> => {
        await settlePendingEditorChanges();
        if (!file || !dirtyRef.current || savingRef.current) return;
        const contentSnapshot = latestContentRef.current;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        setConflict(null);
        try {
            const saved = await saveNoteFile({ path: file.path, content: contentSnapshot, baseRevision: file.revision });
            setFile(saved);
            if (latestContentRef.current === contentSnapshot) {
                latestContentRef.current = saved.content;
                dirtyRef.current = false;
                setContentState(saved.content);
                setDirty(false);
            }
        } catch (saveError) {
            if (isRevisionConflict(saveError)) {
                let remoteRevision = file.revision;
                try {
                    const remote = await fetchNoteFile(file.path);
                    remoteRevision = remote.revision;
                    setFile(remote);
                } catch {
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
        await settlePendingEditorChanges();
        if (!file || savingRef.current) return;
        const contentSnapshot = latestContentRef.current;
        savingRef.current = true;
        setSaving(true);
        setError(null);
        try {
            const saved = await saveNoteFile({ path: file.path, content: contentSnapshot });
            setFile(saved);
            if (latestContentRef.current === contentSnapshot) {
                latestContentRef.current = saved.content;
                dirtyRef.current = false;
                setContentState(saved.content);
                setDirty(false);
            }
            setConflict(null);
        } catch (overwriteError) {
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
