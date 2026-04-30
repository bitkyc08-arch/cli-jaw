import { useCallback, useState } from 'react';
import type { DashboardNoteFileResponse } from '../types';
import { fetchNoteFile, saveNoteFile } from './notes-api';
import { isRevisionConflict } from './note-revisions';
import type { NoteConflictState } from './notes-types';

export type UseNoteDocumentResult = {
    file: DashboardNoteFileResponse | null;
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

export function useNoteDocument(): UseNoteDocumentResult {
    const [file, setFile] = useState<DashboardNoteFileResponse | null>(null);
    const [content, setContentState] = useState('');
    const [dirty, setDirty] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState<NoteConflictState | null>(null);

    const load = useCallback(async (path: string): Promise<void> => {
        setLoading(true);
        setError(null);
        setConflict(null);
        try {
            const next = await fetchNoteFile(path);
            setFile(next);
            setContentState(next.content);
            setDirty(false);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    function setContent(value: string): void {
        setContentState(value);
        setDirty(true);
    }

    const save = useCallback(async (): Promise<void> => {
        if (!file || !dirty) return;
        setSaving(true);
        setError(null);
        setConflict(null);
        try {
            const saved = await saveNoteFile({
                path: file.path,
                content,
                baseRevision: file.revision,
            });
            setFile(saved);
            setContentState(saved.content);
            setDirty(false);
        } catch (err) {
            if (isRevisionConflict(err)) {
                let remoteRevision = file.revision;
                try {
                    const remote = await fetchNoteFile(file.path);
                    remoteRevision = remote.revision;
                    setFile(remote);
                } catch {
                    remoteRevision = file.revision;
                }
                setConflict({
                    localContent: content,
                    remoteRevision,
                    message: (err as Error).message,
                });
            } else {
                setError((err as Error).message);
            }
        } finally {
            setSaving(false);
        }
    }, [content, dirty, file]);

    const reloadFromDisk = useCallback(async (): Promise<void> => {
        if (!file) return;
        await load(file.path);
    }, [file, load]);

    const overwrite = useCallback(async (): Promise<void> => {
        if (!file) return;
        setSaving(true);
        setError(null);
        try {
            const saved = await saveNoteFile({ path: file.path, content });
            setFile(saved);
            setContentState(saved.content);
            setDirty(false);
            setConflict(null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }, [content, file]);

    return {
        file,
        content,
        dirty,
        loading,
        saving,
        error,
        conflict,
        setContent,
        load,
        save,
        reloadFromDisk,
        overwrite,
        clearConflict: () => setConflict(null),
    };
}
