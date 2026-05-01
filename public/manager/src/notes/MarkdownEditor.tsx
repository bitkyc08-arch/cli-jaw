import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { notesEditorTheme, notesSyntaxHighlighting } from './editor-theme';
import { markdownShortcutsKeymap } from './markdown-shortcuts';
import { RichMarkdownPortalHost } from './rich-markdown/RichMarkdownPortalHost';
import { richMarkdownExtension } from './rich-markdown/rich-markdown-extension';
import { richMarkdownPastePolicy } from './rich-markdown/paste-policy';
import type { NotesAuthoringMode } from './notes-types';
import type { RichMarkdownWidgetRegistration } from './rich-markdown/rich-markdown-types';

const MilkdownWysiwygEditor = lazy(async () => {
    const module = await import('./wysiwyg/MilkdownWysiwygEditor');
    return { default: module.MilkdownWysiwygEditor };
});

type MarkdownEditorProps = {
    active: boolean;
    authoringMode: NotesAuthoringMode;
    content: string;
    wordWrap: boolean;
    onChange: (value: string) => void;
};

export function MarkdownEditor(props: MarkdownEditorProps) {
    const [widgets, setWidgets] = useState<Map<string, RichMarkdownWidgetRegistration>>(() => new Map());
    const registerWidget = useCallback((registration: RichMarkdownWidgetRegistration): void => {
        setWidgets(current => {
            const next = new Map(current);
            next.set(registration.id, registration);
            return next;
        });
    }, []);
    const unregisterWidget = useCallback((id: string): void => {
        setWidgets(current => {
            if (!current.has(id)) return current;
            const next = new Map(current);
            next.delete(id);
            return next;
        });
    }, []);
    const requestMeasure = useCallback((): void => {
        window.dispatchEvent(new Event('resize'));
    }, []);
    const extensions = useMemo(() => {
        const base = [
            Prec.highest(keymap.of(markdownShortcutsKeymap)),
            notesEditorTheme,
            notesSyntaxHighlighting,
            markdown({ codeLanguages: languages }),
            richMarkdownPastePolicy(),
            richMarkdownExtension({
                enabled: props.authoringMode === 'rich' || props.authoringMode === 'wysiwyg',
                active: props.active,
                registerWidget,
                unregisterWidget,
                requestMeasure,
            }),
        ];
        if (props.wordWrap) base.push(EditorView.lineWrapping);
        return base;
    }, [props.active, props.authoringMode, props.wordWrap, registerWidget, requestMeasure, unregisterWidget]);

    const isWysiwyg = props.authoringMode === 'wysiwyg';
    if (isWysiwyg) {
        return (
            <div className="notes-editor notes-wysiwyg-editor">
                <Suspense fallback={<div className="notes-wysiwyg-loading">Loading WYSIWYG editor...</div>}>
                    <MilkdownWysiwygEditor active={props.active} content={props.content} onChange={props.onChange} />
                </Suspense>
            </div>
        );
    }

    return (
        <div className="notes-editor">
            <RichMarkdownPortalHost widgets={[...widgets.values()]} />
            <CodeMirror
                value={props.content}
                extensions={extensions}
                onChange={props.onChange}
                height="100%"
                basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                }}
            />
        </div>
    );
}
