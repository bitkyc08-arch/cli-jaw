import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const notesEditorTheme = EditorView.theme({
    '&': {
        height: '100%',
        color: 'var(--text-primary)',
        backgroundColor: 'var(--canvas-deep)',
    },
    '.cm-editor': {
        height: '100%',
        color: 'var(--text-primary)',
        backgroundColor: 'var(--canvas-deep)',
    },
    '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        backgroundColor: 'var(--canvas-deep)',
    },
    '.cm-content': {
        caretColor: 'var(--text-primary)',
    },
    '.cm-gutters': {
        color: 'var(--text-tertiary, var(--text-secondary))',
        backgroundColor: 'var(--canvas-deep)',
        borderRight: '1px solid var(--border-subtle)',
    },
    '.cm-activeLine': {
        backgroundColor: 'var(--canvas-soft)',
    },
    '.cm-activeLineGutter': {
        color: 'var(--text-primary)',
        backgroundColor: 'var(--canvas-soft)',
    },
    '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--text-primary)',
    },
    /* Selection backgrounds are also enforced from global CSS in manager-notes.css to beat
       CodeMirror baseTheme `&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground { background: #233 }`,
       which has higher specificity than any &-prefixed rule we can write inside EditorView.theme. */
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--selection-bg)',
    },
    '&.cm-focused': {
        outline: '1px solid var(--border-strong)',
    },
    '.cm-line': {
        color: 'var(--text-primary)',
    },
    '.cm-panels': {
        color: 'var(--text-primary)',
        backgroundColor: 'var(--bg-panel)',
        borderColor: 'var(--border-subtle)',
    },
    '.cm-tooltip': {
        color: 'var(--text-primary)',
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
        outline: '1px solid var(--accent)',
        backgroundColor: 'var(--accent-soft)',
    },
    '.cm-rich-widget': {
        color: 'var(--text-primary)',
        backgroundColor: 'var(--canvas-soft)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '6px',
    },
    '.cm-rich-block': {
        display: 'block',
        margin: '6px 0',
        padding: '8px 10px',
        overflowX: 'auto',
    },
    '.cm-rich-inline': {
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: '100%',
        padding: '0 4px',
        verticalAlign: 'baseline',
    },
    '.cm-rich-source-muted': {
        color: 'var(--text-tertiary, var(--text-secondary))',
    },
    '.cm-rich-widget-error': {
        color: 'var(--danger-strong, var(--text-primary))',
        borderColor: 'var(--danger-strong, var(--border-subtle))',
    },
}, { dark: true });

const notesHighlightStyle = HighlightStyle.define([
    { tag: tags.heading, color: 'var(--text-primary)', fontWeight: '650' },
    { tag: [tags.strong, tags.emphasis], color: 'var(--text-primary)' },
    { tag: tags.link, color: 'var(--accent-strong, var(--accent))', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--accent-strong, var(--accent))' },
    { tag: [tags.keyword, tags.atom, tags.bool], color: 'var(--accent-strong, var(--accent))' },
    { tag: [tags.string, tags.special(tags.string)], color: 'var(--success-strong, var(--text-primary))' },
    { tag: [tags.comment, tags.quote], color: 'var(--text-tertiary, var(--text-secondary))' },
    { tag: [tags.number, tags.integer, tags.float], color: 'var(--warning-strong, var(--text-primary))' },
    { tag: [tags.variableName, tags.propertyName], color: 'var(--text-primary)' },
    { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: 'var(--accent)' },
    { tag: [tags.punctuation, tags.bracket], color: 'var(--text-secondary)' },
    { tag: tags.invalid, color: 'var(--danger-strong, var(--text-primary))' },
]);

export const notesSyntaxHighlighting = syntaxHighlighting(notesHighlightStyle);
