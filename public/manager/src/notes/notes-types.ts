import type { DashboardNoteFileResponse, DashboardNoteTreeEntry } from '../types';

export type NotesViewMode = 'raw' | 'split' | 'preview' | 'settings';
export type NotesAuthoringMode = 'plain' | 'rich';

export type NotesTreeSelection = {
    selectedPath: string | null;
};

export type NoteConflictState = {
    localContent: string;
    remoteRevision: string;
    message: string;
};

export type NotesTreeEntry = DashboardNoteTreeEntry;
export type NoteFile = DashboardNoteFileResponse;
