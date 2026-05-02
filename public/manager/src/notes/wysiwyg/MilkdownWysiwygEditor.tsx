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
import { insertTableCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { callCommand, getMarkdown, insert, replaceAll } from '@milkdown/kit/utils';
import { safeMarkdownUrl } from '../markdown-security';
import { firstClipboardImage } from '../image-assets/clipboard-images';
import { uploadClipboardImageMarkdown } from '../image-assets/insert-image-markdown';
import { notesMilkdownBlockKeymap } from './milkdown-block-keymap';
import { notesMilkdownCodeBlockView } from './milkdown-code-block-view';
import { notesMilkdownGfm } from './milkdown-gfm-safe';
import { notesMilkdownHeadingSourceView } from './milkdown-heading-source-view';
import { notesMilkdownKatexOptionsCtx, notesMilkdownMath } from './milkdown-math';
import { normalizeEscapedTaskMarkers, protectUnsupportedGfmForMilkdown } from './milkdown-task-markers';

type MilkdownWysiwygEditorProps = {
    active: boolean;
    content: string;
    notePath: string;
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
                ctx.set(defaultValueCtx, protectUnsupportedGfmForMilkdown(latestMarkdownRef.current));
                ctx.set(notesMilkdownKatexOptionsCtx.key, {
                    throwOnError: false,
                    strict: 'warn',
                });
                ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
                    const normalizedMarkdown = normalizeEscapedTaskMarkers(markdown);
                    latestMarkdownRef.current = normalizedMarkdown;
                    if (syncingFromPropsRef.current) return;
                    onChangeRef.current(normalizedMarkdown);
                });
            })
            .use(commonmark)
            .use(notesMilkdownGfm)
            .use(notesMilkdownHeadingSourceView)
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
                    instance.action(replaceAll(protectUnsupportedGfmForMilkdown(latestPropContentRef.current), true));
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
        editor.action(replaceAll(protectUnsupportedGfmForMilkdown(props.content), true));
        queueMicrotask(() => {
            syncingFromPropsRef.current = false;
        });
    }, [props.content]);

    useEffect(() => {
        if (props.active && ready) focusEditable(rootRef.current);
    }, [props.active, ready]);

    useEffect(() => {
        if (!ready) return undefined;
        const root = rootRef.current;
        if (!root) return undefined;

        function handleHeadingSourceUpdated(): void {
            editorRef.current?.action(ctx => {
                const markdown = normalizeEscapedTaskMarkers(getMarkdown()(ctx));
                latestMarkdownRef.current = markdown;
                if (!syncingFromPropsRef.current) onChangeRef.current(markdown);
            });
        }

        root.addEventListener('notes-heading-source-updated', handleHeadingSourceUpdated);
        return () => {
            root.removeEventListener('notes-heading-source-updated', handleHeadingSourceUpdated);
        };
    }, [ready]);

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

    function insertTable(): void {
        run(editor => editor.action(callCommand(insertTableCommand.key, { row: 3, col: 3 })));
    }

    function insertTaskListItem(): void {
        const currentMarkdown = latestMarkdownRef.current.trimEnd();
        const nextMarkdown = `${currentMarkdown}${currentMarkdown ? '\n\n' : ''}- [ ] `;
        latestMarkdownRef.current = nextMarkdown;
        onChangeRef.current(nextMarkdown);
        run(editor => editor.action(replaceAll(protectUnsupportedGfmForMilkdown(nextMarkdown), true)));
    }

    useEffect(() => {
        if (!ready) return undefined;
        const root = rootRef.current;
        if (!root) return undefined;

        function syncTaskListAccessibility(): void {
            root!.querySelectorAll<HTMLElement>('li[data-item-type="task"][data-checked]').forEach(item => {
                const checked = item.dataset.checked === 'true';
                item.setAttribute('role', 'checkbox');
                item.setAttribute('aria-checked', checked ? 'true' : 'false');
                item.setAttribute('tabindex', '0');
                item.setAttribute('aria-label', item.textContent?.trim() || (checked ? 'Checked task' : 'Unchecked task'));
            });
        }

        function toggleTaskItem(item: HTMLElement): void {
            editorRef.current?.action(ctx => {
                const view = ctx.get(editorViewCtx);
                const pos = view.posAtDOM(item, 0);
                const resolved = view.state.doc.resolve(pos);
                for (let depth = resolved.depth; depth > 0; depth -= 1) {
                    const node = resolved.node(depth);
                    if (node.type.name !== 'list_item' || node.attrs.checked == null) continue;
                    const listItemPos = resolved.before(depth);
                    view.dispatch(view.state.tr.setNodeMarkup(listItemPos, undefined, {
                        ...node.attrs,
                        checked: !node.attrs.checked,
                    }).scrollIntoView());
                    const markdown = normalizeEscapedTaskMarkers(getMarkdown()(ctx));
                    latestMarkdownRef.current = markdown;
                    if (!syncingFromPropsRef.current) onChangeRef.current(markdown);
                    queueMicrotask(syncTaskListAccessibility);
                    return;
                }
            });
        }

        function handleTaskListClick(event: MouseEvent): void {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const rootEl = root!;
            const directItem = target.closest<HTMLElement>('li[data-item-type="task"][data-checked]');
            const item = directItem && rootEl.contains(directItem)
                ? directItem
                : Array.from(rootEl.querySelectorAll<HTMLElement>('li[data-item-type="task"][data-checked]'))
                    .find(candidate => {
                        const rect = candidate.getBoundingClientRect();
                        return event.clientY >= rect.top
                            && event.clientY <= rect.bottom
                            && event.clientX >= rect.left
                            && event.clientX <= rect.left + 26;
                    }) ?? null;
            if (!item || !rootEl.contains(item)) return;
            const rect = item.getBoundingClientRect();
            if (event.clientX > rect.left + 26) return;
            event.preventDefault();
            toggleTaskItem(item);
        }

        function handleTaskListKeyDown(event: KeyboardEvent): void {
            if (event.key !== ' ' && event.key !== 'Enter') return;
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const item = target.closest<HTMLElement>('li[data-item-type="task"][data-checked]');
            if (!item || !root!.contains(item)) return;
            event.preventDefault();
            toggleTaskItem(item);
        }

        syncTaskListAccessibility();
        const observer = new MutationObserver(syncTaskListAccessibility);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-checked'] });
        root.addEventListener('click', handleTaskListClick);
        root.addEventListener('keydown', handleTaskListKeyDown, true);
        return () => {
            observer.disconnect();
            root.removeEventListener('click', handleTaskListClick);
            root.removeEventListener('keydown', handleTaskListKeyDown, true);
        };
    }, [ready]);

    function handlePasteCapture(event: ClipboardEvent<HTMLDivElement>): void {
        const imageFallback = event.clipboardData.getData('text/plain');
        if (firstClipboardImage(event.clipboardData)) {
            event.preventDefault();
            void uploadClipboardImageMarkdown(props.notePath, event.clipboardData)
                .then(markdown => {
                    if (markdown) {
                        run(editor => editor.action(insert(markdown, true)));
                        return;
                    }
                    if (imageFallback) run(editor => editor.action(insert(imageFallback)));
                })
                .catch(error => {
                    console.warn('[notes-image-paste]', error);
                    if (imageFallback) run(editor => editor.action(insert(imageFallback)));
                });
            return;
        }
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
                <button type="button" title="Strikethrough" aria-label="Strikethrough" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(toggleStrikethroughCommand.key)))}>S</button>
                <button type="button" title="Inline code" aria-label="Inline code" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(toggleInlineCodeCommand.key)))}>Code</button>
                <button type="button" title="Link" aria-label="Link" disabled={!ready} onClick={insertSafeLink}>Link</button>
                <button type="button" title="Inline math" aria-label="Inline math" disabled={!ready} onClick={insertInlineMath}>Math</button>
                <button type="button" title="Block math" aria-label="Block math" disabled={!ready} onClick={insertBlockMath}>Math Block</button>
                <button type="button" title="Heading" aria-label="Heading level 2" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(wrapInHeadingCommand.key, 2)))}>H2</button>
                <button type="button" title="List" aria-label="Bullet list" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(wrapInBulletListCommand.key)))}>List</button>
                <button type="button" title="Task list" aria-label="Task list" disabled={!ready} onMouseDown={event => event.preventDefault()} onClick={insertTaskListItem}>Task</button>
                <button type="button" title="Quote" aria-label="Quote" disabled={!ready} onClick={() => run(editor => editor.action(callCommand(wrapInBlockquoteCommand.key)))}>Quote</button>
                <button type="button" title="Table" aria-label="Table" disabled={!ready} onClick={insertTable}>Table</button>
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
