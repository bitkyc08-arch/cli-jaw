import { RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { scanMarkdownRichRanges } from './scan-markdown-tree';
import { RichMarkdownWidget } from './rich-widget';
import type { RichMarkdownExtensionOptions, RichMarkdownRange } from './rich-markdown-types';

const MAX_RICH_WIDGETS_PER_VIEWPORT = 50;
const MAX_TASK_WIDGETS_PER_VIEWPORT = 100;
const MAX_RENDERED_SNIPPET_BYTES = 50_000;
const MAX_MERMAID_WIDGETS_PER_VIEWPORT = 5;
const LARGE_NOTE_RICH_DISABLE_THRESHOLD = 1_000_000;
const taskLinePattern = /^([ \t]*[-*+][ \t]+)\[([ xX])\]([ \t]*)(.*)$/;

type TaskLineRange = {
    from: number;
    to: number;
    markerFrom: number;
    checked: boolean;
    text: string;
};

type DecorationEntry = {
    from: number;
    to: number;
    decoration: Decoration;
};

class TaskLineWidget extends WidgetType {
    constructor(private readonly range: TaskLineRange) {
        super();
    }

    eq(other: WidgetType): boolean {
        return other instanceof TaskLineWidget
            && other.range.markerFrom === this.range.markerFrom
            && other.range.checked === this.range.checked
            && other.range.text === this.range.text;
    }

    toDOM(view: EditorView): HTMLElement {
        const label = document.createElement('label');
        label.className = 'cm-rich-task-widget';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        const text = document.createElement('span');
        label.append(checkbox, text);
        this.syncDOM(label, view);
        return label;
    }

    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        if (!dom.classList.contains('cm-rich-task-widget')) return false;
        this.syncDOM(dom, view);
        return true;
    }

    destroy(dom: HTMLElement): void {
        const checkbox = dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (checkbox) checkbox.onchange = null;
    }

    ignoreEvent(event: Event): boolean {
        return event.type === 'mousedown'
            || event.type === 'click'
            || event.type === 'change'
            || event.type === 'input'
            || event.type === 'keydown';
    }

    private syncDOM(dom: HTMLElement, view: EditorView): void {
        const checkbox = dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
        const text = dom.querySelector<HTMLSpanElement>('span');
        if (!checkbox || !text) return;
        checkbox.checked = this.range.checked;
        checkbox.setAttribute('aria-label', this.range.text || (this.range.checked ? 'Checked task' : 'Unchecked task'));
        checkbox.setAttribute('aria-checked', this.range.checked ? 'true' : 'false');
        checkbox.onchange = () => {
            view.dispatch({
                changes: {
                    from: this.range.markerFrom,
                    to: this.range.markerFrom + 3,
                    insert: checkbox.checked ? '[x]' : '[ ]',
                },
                userEvent: 'input.task-toggle',
            });
        };
        text.textContent = this.range.text || 'Task';
    }
}

function rangeId(range: RichMarkdownRange): string {
    return `rich-${range.kind}-${range.from}-${range.to}-${range.markdown.length}`;
}

function scanTaskLineRanges(state: EditorState): TaskLineRange[] {
    const ranges: TaskLineRange[] = [];
    const selection = state.selection.main;
    let inFence = false;
    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
        if (ranges.length >= MAX_TASK_WIDGETS_PER_VIEWPORT) break;
        const line = state.doc.line(lineNumber);
        if (/^```/.test(line.text.trim())) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (selection.from <= line.to && selection.to >= line.from) continue;
        const match = line.text.match(taskLinePattern);
        if (!match) continue;
        ranges.push({
            from: line.from,
            to: line.to,
            markerFrom: line.from + match[1].length,
            checked: match[2].toLowerCase() === 'x',
            text: match[4].trim(),
        });
    }
    return ranges;
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
    const decorations: DecorationEntry[] = [];
    for (const taskRange of scanTaskLineRanges(state)) {
        decorations.push({
            from: taskRange.from,
            to: taskRange.to,
            decoration: Decoration.replace({
                widget: new TaskLineWidget(taskRange),
            }),
        });
    }
    for (const range of ranges) {
        decorations.push({
            from: range.from,
            to: range.to,
            decoration: Decoration.replace({
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
            }),
        });
    }
    decorations.sort((left, right) => {
        const fromDelta = left.from - right.from;
        if (fromDelta !== 0) return fromDelta;
        const startSideDelta = left.decoration.startSide - right.decoration.startSide;
        if (startSideDelta !== 0) return startSideDelta;
        return left.to - right.to;
    });
    const builder = new RangeSetBuilder<Decoration>();
    for (const entry of decorations) {
        builder.add(entry.from, entry.to, entry.decoration);
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
            return [
                EditorView.decorations.from(field),
                EditorView.atomicRanges.of(view => view.state.field(field, false) ?? Decoration.none),
            ];
        },
    });
}
