import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { scanMarkdownRichRanges } from './scan-markdown-tree';
import { RichMarkdownWidget } from './rich-widget';
import type { RichMarkdownExtensionOptions, RichMarkdownRange } from './rich-markdown-types';

const MAX_RICH_WIDGETS_PER_VIEWPORT = 50;
const MAX_RENDERED_SNIPPET_BYTES = 50_000;
const MAX_MERMAID_WIDGETS_PER_VIEWPORT = 5;
const LARGE_NOTE_RICH_DISABLE_THRESHOLD = 1_000_000;

function rangeId(range: RichMarkdownRange): string {
    return `rich-${range.kind}-${range.from}-${range.to}-${range.markdown.length}`;
}

function buildDecorations(state: EditorState, options: RichMarkdownExtensionOptions): DecorationSet {
    if (!options.enabled || !options.active) return Decoration.none;
    const selection = state.selection.main;
    const ranges = scanMarkdownRichRanges(state.doc.toString(), {
        selectionFrom: selection.from,
        selectionTo: selection.to,
        maxWidgets: MAX_RICH_WIDGETS_PER_VIEWPORT,
        maxSnippetBytes: MAX_RENDERED_SNIPPET_BYTES,
        maxMermaidWidgets: MAX_MERMAID_WIDGETS_PER_VIEWPORT,
        largeNoteDisableThreshold: LARGE_NOTE_RICH_DISABLE_THRESHOLD,
    });
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ranges) {
        builder.add(range.from, range.to, Decoration.replace({
            block: range.block,
            widget: new RichMarkdownWidget({
                id: rangeId(range),
                kind: range.kind,
                markdown: range.markdown,
                block: range.block,
                registerWidget: options.registerWidget,
                unregisterWidget: options.unregisterWidget,
                requestMeasure: options.requestMeasure,
            }),
        }));
    }
    return builder.finish();
}

export function richMarkdownExtension(options: RichMarkdownExtensionOptions) {
    return StateField.define<DecorationSet>({
        create(state) {
            return buildDecorations(state, options);
        },
        update(value, transaction) {
            if (transaction.docChanged || transaction.selection) {
                return buildDecorations(transaction.state, options);
            }
            return value.map(transaction.changes);
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
}

