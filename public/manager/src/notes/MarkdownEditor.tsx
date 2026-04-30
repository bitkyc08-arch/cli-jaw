import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { useCallback, useMemo, useState } from 'react';
import { notesEditorTheme, notesSyntaxHighlighting } from './editor-theme';
import { RichMarkdownPortalHost } from './rich-markdown/RichMarkdownPortalHost';
import { richMarkdownExtension } from './rich-markdown/rich-markdown-extension';
import { richMarkdownPastePolicy } from './rich-markdown/paste-policy';
import type { NotesAuthoringMode } from './notes-types';
import type { RichMarkdownWidgetRegistration } from './rich-markdown/rich-markdown-types';

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
    const extensions = useMemo(() => [
        notesEditorTheme,
        notesSyntaxHighlighting,
        markdown({ codeLanguages: languages }),
        richMarkdownPastePolicy(),
        richMarkdownExtension({
            enabled: props.authoringMode === 'rich',
            active: props.active,
            registerWidget,
            unregisterWidget,
            requestMeasure,
        }),
    ], [props.active, props.authoringMode, registerWidget, requestMeasure, unregisterWidget]);

    return (
        <div className={`notes-editor${props.wordWrap ? ' is-word-wrapped' : ''}`}>
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
