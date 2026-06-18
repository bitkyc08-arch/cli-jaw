import { useCallback, useEffect, useRef, useState } from 'react';

export type FolderChordState = {
    folderChordActive: boolean;
    startFolderChord: () => void;
    cancelFolderChord: () => void;
};

export function useFolderChord(timeoutMs = 1600): FolderChordState {
    const [folderChordActive, setFolderChordActive] = useState(false);
    const folderChordTimerRef = useRef<number | null>(null);

    const cancelFolderChord = useCallback(() => {
        if (folderChordTimerRef.current !== null) window.clearTimeout(folderChordTimerRef.current);
        folderChordTimerRef.current = null;
        setFolderChordActive(false);
    }, []);

    const startFolderChord = useCallback(() => {
        if (folderChordTimerRef.current !== null) window.clearTimeout(folderChordTimerRef.current);
        setFolderChordActive(true);
        folderChordTimerRef.current = window.setTimeout(() => {
            folderChordTimerRef.current = null;
            setFolderChordActive(false);
        }, timeoutMs);
    }, [timeoutMs]);

    useEffect(() => () => cancelFolderChord(), [cancelFolderChord]);

    return { folderChordActive, startFolderChord, cancelFolderChord };
}
