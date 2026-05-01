import { type ClipboardEvent, useEffect, useRef, useState } from 'react';
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, schemaCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import {
    createCodeBlockCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { safeMarkdownUrl } from '../markdown-security';
import { notesMilkdownBlockKeymap } from './milkdown-block-keymap';
import { notesMilkdownCodeBlockView } from './milkdown-code-block-view';
import { notesMilkdownKatexOptionsCtx, notesMilkdownMath } from './milkdown-math';

type MilkdownWysiwygEditorProps = {
    active: boolean;
    content: string;
    onChange: (value: string) => void;
};

type MilkdownCommand = (editor: Editor) => void;

function focusEditable(root: HTMLDivElement | null): void {
    root?.querySelector<HTMLElement>('.ProseMirror')?.focus();
}

function htmlToPlainText(html: string): string {
    const element = document.createElement('div');
    element.innerHTML = html;
    return element.textContent ?? '';
}

function normalizeCodeLanguage(language: string): string {
    return language.trim().toLowerCase().replace(/[^a-z0-9_+-]/g, '');
}

export function MilkdownWysiwygEditor(props: MilkdownWysiwygEditorProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<Editor | null>(null);
    const latestMarkdownRef = useRef(props.content);
    const latestPropContentRef = useRef(props.content);
    const onChangeRef = useRef(props.onChange);
    const syncingFromPropsRef = useRef(true);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        onChangeRef.current = props.onChange;
    }, [props.onChange]);

    useEffect(() => {
        latestPropContentRef.current = props.content;
    }, [props.content]);

    useEffect(() => {
        let disposed = false;
        let editor: Editor | null = null;
        const root = rootRef.current;
        if (!root) return undefined;

        void Editor.make()
            .config(ctx => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, latestMarkdownRef.current);
                ctx.set(notesMilkdownKatexOptionsCtx.key, {
                    throwOnError: false,
                    strict: 'warn',
                });
                ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
                    latestMarkdownRef.current = markdown;
                    if (syncingFromPropsRef.current) return;
                    onChangeRef.current(markdown);
                });
            })
            .use(commonmark)
            .use(gfm)
            .use(notesMilkdownMath)
            .use(notesMilkdownCodeBlockView)
            .use(notesMilkdownBlockKeymap)
            .use(history)
            .use(clipboard)
            .use(listener)
            .create()
            .then(instance => {
                if (disposed) {
                    void instance.destroy();
                    return;
                }
                editor = instance;
                editorRef.current = instance;
                if (latestPropContentRef.current !== latestMarkdownRef.current) {
                    latestMarkdownRef.current = latestPropContentRef.current;
                    instance.action(replaceAll(latestPropContentRef.current, true));
                }
                setReady(true);
                queueMicrotask(() => {
                    syncingFromPropsRef.current = false;
                });
                if (props.active) focusEditable(root);
            })
            .catch(error => {
                console.error('[notes-wysiwyg]', error);
                setError(error instanceof Error ? error.message : 'WYSIWYG editor failed to load');
                setReady(false);
            });

        return () => {
            disposed = true;
            setReady(false);
            editorRef.current = null;
            if (editor) void editor.destroy();
        };
    }, []);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        if (props.content === latestMarkdownRef.current) return;
        syncingFromPropsRef.current = true;
        latestMarkdownRef.current = props.content;
        editor.action(replaceAll(props.content, true));
        queueMicrotask(() => {
            syncingFromPropsRef.current = false;
        });
    }, [props.content]);

    useEffect(() => {
        if (props.active && ready) focusEditable(rootRef.current);
    }, [props.active, ready]);

    function run(command: MilkdownCommand): void {
        const editor = editorRef.current;
        if (!editor) return;
        focusEditable(rootRef.current);
        command(editor);
    }

    function insertSafeLink(): void {
        const href = window.prompt('Link URL');
        if (!href) return;
        const safeHref = safeMarkdownUrl(href.trim());
        if (!safeHref) return;
        run(editor => editor.action(insert(`[link](${safeHref})`, true)));
    }

    function insertInlineMath(): void {
        const expression = window.prompt('Inline math');
        if (!expression) return;
        run(editor => editor.action(ctx => {
            const view = ctx.get(editorViewCtx);
            const schema = ctx.get(schemaCtx);
            const node = schema.nodes.math_inline?.create({ value: expression.trim() });
            if (!node) return;
            view.dispatch(view.state.tr.replaceSelectionWith(node, true).scrollIntoView());
        }));
    }

    function insertBlockMath(): void {
        const expression = window.prompt('Block math');
        if (!expression) return;
        run(editor => editor.action(ctx => {
            const view = ctx.get(editorViewCtx);
            const schema = ctx.get(schemaCtx);
            const node = schema.nodes.math_block?.create({ value: expression.trim() });
            if (!node) return;
            view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
        }));
    }

    function createLanguageCodeBlock(): void {
        const language = normalizeCodeLanguage(window.prompt('Code block language') ?? '');
        run(editor => editor.action(callCommand(createCodeBlockCommand.key, language)));
    }

    function handlePasteCapture(event: ClipboardEvent<HTMLDivElement>): void {
        const html = event.clipboardData.getData('text/html');
        if (!html) return;
        event.preventDefault();
        const text = event.clipboardData.getData('text/plain');
        const plainText = text || htmlToPlainText(html);
        if (!plainText) return;
        run(editor => editor.action(insert(plainText)));
    }

    return (
        <div className="notes-milkdown-shell" onPasteCapture={handlePasteCapture}>
            <div className="notes-wysiwyg-toolbar" aria-label="WYSIWYG formatting tools">
                <button type="button" title="Bold" aria-label="Bold" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(toggleStrongCommand.key)))}>B</button>
                <button type="button" title="Italic" aria-label="Italic" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(toggleEmphasisCommand.key)))}>I</button>
                <button type="button" title="Inline code" aria-label="Inline code" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(toggleInlineCodeCommand.key)))}>Code</button>
                <button type="button" title="Link" aria-label="Link" disabled={!ready} onClick={insertSafeLink}>Link</button>
                <button type="button" title="Inline math" aria-label="Inline math" disabled={!ready} onClick={insertInlineMath}>Math</button>
                <button type="button" title="Block math" aria-label="Block math" disabled={!ready} onClick={insertBlockMath}>Math Block</button>
                <button type="button" title="Heading" aria-label="Heading level 2" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(wrapInHeadingCommand.key, 2)))}>H2</button>
                <button type="button" title="List" aria-label="Bullet list" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(wrapInBulletListCommand.key)))}>List</button>
                <button type="button" title="Quote" aria-label="Quote" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(wrapInBlockquoteCommand.key)))}>Quote</button>
                <button type="button" title="Code block" aria-label="Code block" disabled={!ready} onClick={createLanguageCodeBlock}>Block</button>
            </div>
            {error && <div className="notes-wysiwyg-error" role="alert">{error}</div>}
            <div
                ref={rootRef}
                className="notes-milkdown-root"
                data-ready={ready ? 'true' : 'false'}
                aria-label="Milkdown WYSIWYG markdown editor"
                role="textbox"
                aria-multiline="true"
            />
        </div>
    );
}
