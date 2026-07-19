import { useEffect, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNotesModel } from '../features/notes/useNotesModel.ts';
import { useNoteDocument } from '../features/notes/useNoteDocument.ts';

// Test-only wire harness (070): captures every fetch issued by the notes
// feature — method/url/body/headers/stack — and mounts the real consumers so
// typed-error UI state and the useNoteDocument stale-load race are observable.

export interface WireCaptureEntry {
    url: string;
    method: string;
    body: string | null;
    headers: Record<string, string>;
    stack: string;
}

declare global {
    interface Window {
        __wireCapture?: WireCaptureEntry[];
        __wireModel?: { refresh(): void };
        __wireProbe?: {
            loadBoth(pathA: string, pathB: string): void;
            settled(): Promise<void>;
            load(path: string): Promise<void>;
            save(): Promise<void>;
            overwrite(): Promise<void>;
            edit(content: string): void;
        };
    }
}

function installFetchCapture(): void {
    if (window.__wireCapture) return;
    const captures: WireCaptureEntry[] = [];
    window.__wireCapture = captures;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/')) {
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
            const body = init?.body === undefined || init?.body === null ? null : String(init.body);
            captures.push({
                url,
                method: (init?.method ?? 'GET').toUpperCase(),
                body,
                headers,
                stack: new Error('wire-capture').stack ?? '',
            });
        }
        return original(input, init);
    };
}

installFetchCapture();

function NotesModelProbe(): JSX.Element {
    const model = useNotesModel({
        active: true,
        selectedPath: null,
        onSelectedPathChange: () => {},
    });
    const refreshRef = useRef(model.refresh);
    refreshRef.current = model.refresh;
    useEffect(() => {
        window.__wireModel = { refresh: () => { void refreshRef.current(); } };
        return () => { delete window.__wireModel; };
    }, []);
    return (
        <section data-testid="notes-model-probe">
            <span data-testid="notes-tree-count">{model.tree.length}</span>
            <span data-testid="notes-error">{model.error ?? ''}</span>
            <span data-testid="notes-root">{model.notesRoot ?? ''}</span>
        </section>
    );
}

function NoteDocumentProbe(): JSX.Element {
    const doc = useNoteDocument();
    const docRef = useRef(doc);
    docRef.current = doc;
    const settleRef = useRef<Promise<void>>(Promise.resolve());
    const track = (pending: Promise<void>): Promise<void> => {
        settleRef.current = Promise.allSettled([settleRef.current, pending]).then(() => undefined);
        return pending;
    };
    useEffect(() => {
        window.__wireProbe = {
            loadBoth(pathA: string, pathB: string) {
                const first = docRef.current.load(pathA);
                const second = docRef.current.load(pathB);
                settleRef.current = Promise.allSettled([first, second]).then(() => undefined);
            },
            async settled() {
                await settleRef.current;
            },
            load: (path: string) => track(docRef.current.load(path)),
            save: () => track(docRef.current.save()),
            overwrite: () => track(docRef.current.overwrite()),
            edit: (content: string) => { docRef.current.setContent(content); },
        };
        return () => { delete window.__wireProbe; };
    }, []);
    return (
        <section data-testid="note-document-probe">
            <span data-testid="doc-path">{doc.file?.path ?? ''}</span>
            <span data-testid="doc-content">{doc.content}</span>
            <span data-testid="doc-error">{doc.error ?? ''}</span>
            <span data-testid="doc-loading">{String(doc.loading)}</span>
            <span data-testid="doc-dirty">{String(doc.dirty)}</span>
            <span data-testid="doc-revision">{doc.file?.revision ?? ''}</span>
            <span data-testid="doc-conflict">{doc.conflict ? 'conflict' : ''}</span>
        </section>
    );
}

function Harness(): JSX.Element {
    const [mounted] = useState(true);
    if (!mounted) return <main data-testid="runtime-api-wire-harness" />;
    return (
        <main data-testid="runtime-api-wire-harness">
            <NotesModelProbe />
            <NoteDocumentProbe />
        </main>
    );
}

let root: Root | null = null;

export function mountRuntimeApiWireHarness(target: HTMLElement): void {
    if (!root) root = createRoot(target);
    root.render(<Harness />);
}
