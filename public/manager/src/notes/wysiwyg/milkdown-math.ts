import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { KatexOptions } from 'katex';
import katex from 'katex';
import remarkMath from 'remark-math';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $ctx, $inputRule, $nodeSchema, $remark, $view } from '@milkdown/kit/utils';

const mathInlineId = 'math_inline';
const mathBlockId = 'math_block';

export const notesMilkdownKatexOptionsCtx = $ctx<KatexOptions, 'notesKatexOptions'>(
    {},
    'notesKatexOptions',
);

const notesRemarkMathPlugin = $remark<'notesRemarkMath', undefined>(
    'notesRemarkMath',
    () => remarkMath,
);

function renderKatex(target: HTMLElement, code: string, options: KatexOptions): void {
    target.textContent = '';
    try {
        katex.render(code, target, options);
    } catch {
        target.textContent = code;
    }
}

function updateMathNode(view: EditorView, getPos: () => number | undefined, value: string): void {
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value }).scrollIntoView());
}

function inlineMathSource(value: string): string {
    return `$${value}$`;
}

function blockMathSource(value: string): string {
    return `$$\n${value}\n$$`;
}

function parseInlineMathSource(source: string): string {
    const trimmed = source.trim();
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4) {
        return trimmed.slice(2, -2).trim();
    }
    if (trimmed.startsWith('$') && trimmed.endsWith('$') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).trim();
    }
    return source;
}

function parseBlockMathSource(source: string): string {
    const trimmed = source.trim();
    if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4) {
        return trimmed.slice(2, -2).trim();
    }
    return source;
}

function isClosedMathSource(source: string, block: boolean): boolean {
    const trimmed = source.trim();
    if (block) return trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length >= 4;
    return trimmed.startsWith('$') && trimmed.endsWith('$') && trimmed.length >= 2;
}

function isCaretAtEnd(raw: HTMLInputElement | HTMLTextAreaElement): boolean {
    return raw.selectionStart === raw.value.length && raw.selectionEnd === raw.value.length;
}

function isCaretAtMathBoundary(raw: HTMLInputElement | HTMLTextAreaElement, block: boolean): boolean {
    const selectionStart = raw.selectionStart ?? 0;
    const selectionEnd = raw.selectionEnd ?? 0;
    const value = raw.value;
    if (selectionStart !== selectionEnd) {
        return selectionStart === 0 && selectionEnd === value.length;
    }
    if (selectionStart === 0 || selectionStart === value.length) return true;
    if (!block) return false;
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const nextNewline = value.indexOf('\n', selectionStart);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const line = value.slice(lineStart, lineEnd);
    return /^\$\$$/.test(line);
}

function commitAndExitMathNode(
    view: EditorView,
    getPos: () => number | undefined,
    block: boolean,
    value: string,
    direction: 'above' | 'below',
): void {
    const pos = getPos();
    if (pos === undefined) return;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value });

    if (direction === 'above' && block) {
        const $math = tr.doc.resolve(pos);
        const prevIndex = $math.index() - 1;
        if (prevIndex >= 0) {
            const prevNode = $math.parent.child(prevIndex);
            if (prevNode.isTextblock) {
                tr.setSelection(TextSelection.create(tr.doc, pos - 1));
                view.dispatch(tr.scrollIntoView());
                return;
            }
        }
        const paragraph = view.state.schema.nodes.paragraph?.create();
        if (!paragraph) return;
        tr.insert(pos, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        view.dispatch(tr.scrollIntoView());
        return;
    }

    const after = tr.mapping.map(pos + node.nodeSize);
    if (block) {
        const paragraph = view.state.schema.nodes.paragraph?.create();
        if (!paragraph) return;
        tr.insert(after, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
    } else if (direction === 'above') {
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos), -1));
    } else {
        tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1));
    }
    view.dispatch(tr.scrollIntoView());
}

function exitDirectionForMathCaret(raw: HTMLInputElement | HTMLTextAreaElement, block: boolean): 'above' | 'below' {
    const selectionStart = raw.selectionStart ?? 0;
    const value = raw.value;
    if (selectionStart === 0) return 'above';
    if (selectionStart === value.length) return 'below';
    if (!block) return 'below';
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const nextNewline = value.indexOf('\n', selectionStart);
    const lineEnd = nextNewline === -1 ? value.length : nextNewline;
    const line = value.slice(lineStart, lineEnd);
    if (/^\$\$$/.test(line)) return lineStart === 0 ? 'above' : 'below';
    return 'below';
}

function createMathView(options: {
    block: boolean;
    render: (target: HTMLElement, code: string) => void;
}): NodeViewConstructor {
    return (node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        let currentNode = node;
        const dom = document.createElement(options.block ? 'div' : 'span');
        const rendered = document.createElement(options.block ? 'div' : 'span');
        const raw = options.block ? document.createElement('textarea') : document.createElement('input');
        const label = options.block ? document.createElement('span') : null;

        dom.className = options.block
            ? 'notes-math-node notes-math-block-node'
            : 'notes-math-node notes-math-inline-node';
        dom.contentEditable = 'false';
        dom.tabIndex = 0;
        rendered.className = 'notes-math-rendered';
        raw.className = 'notes-math-raw';
        raw.setAttribute('aria-label', options.block ? 'Edit block math source' : 'Edit inline math source');
        if (raw instanceof HTMLInputElement) raw.type = 'text';
        if (label) {
            label.className = 'notes-math-label';
            label.textContent = 'math';
            dom.append(label);
        }
        dom.append(rendered, raw);

        function value(): string {
            return String(currentNode.attrs.value ?? '');
        }

        function setEditing(editing: boolean): void {
            if (dom.dataset.editing === 'true' && editing) return;
            if (!editing && dom.dataset.editing !== 'true') return;
            dom.dataset.editing = editing ? 'true' : 'false';
            if (editing) {
                raw.value = options.block ? blockMathSource(value()) : inlineMathSource(value());
                raw.focus();
                raw.select();
            } else {
                raw.blur();
            }
        }

        function exitToNextParagraph(direction: 'above' | 'below' = 'below'): void {
            const parsed = options.block ? parseBlockMathSource(raw.value) : parseInlineMathSource(raw.value);
            setEditing(false);
            commitAndExitMathNode(view, getPos, options.block, parsed, direction);
            view.focus();
        }

        function sync(): void {
            const code = value();
            dom.dataset.value = code;
            if (dom.dataset.editing !== 'true') {
                raw.value = options.block ? blockMathSource(code) : inlineMathSource(code);
            }
            options.render(rendered, code);
        }

        function revealRawControl(targetDom: Element | null): void {
            if (!(targetDom instanceof HTMLElement)) return;
            const targetRaw = targetDom.querySelector('.notes-math-raw');
            if (!(targetRaw instanceof HTMLInputElement || targetRaw instanceof HTMLTextAreaElement)) return;
            targetDom.dataset.editing = 'true';
            targetRaw.focus();
            targetRaw.select();
        }

        function openFromRenderedEvent(event: Event): void {
            if (raw.contains(event.target as Node)) return;
            if (dom.dataset.editing === 'true') return;
            event.preventDefault();
            event.stopPropagation();
            const pointer = event instanceof PointerEvent || event instanceof MouseEvent
                ? { x: event.clientX, y: event.clientY }
                : null;
            setTimeout(() => {
                if (dom.isConnected) {
                    setEditing(true);
                    return;
                }
                const targetDom = pointer
                    ? document.elementFromPoint(pointer.x, pointer.y)?.closest('.notes-math-node') ?? null
                    : null;
                revealRawControl(targetDom);
            }, 0);
        }

        dom.addEventListener('pointerdown', openFromRenderedEvent, { capture: true });
        dom.addEventListener('mousedown', openFromRenderedEvent, { capture: true });
        dom.addEventListener('click', openFromRenderedEvent);
        dom.addEventListener('keydown', event => {
            const keyEvent = event as KeyboardEvent;
            if (keyEvent.target !== dom) return;
            if (dom.dataset.editing === 'true') return;
            if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                keyEvent.preventDefault();
                setEditing(true);
            }
        });
        raw.addEventListener('input', () => {
            updateMathNode(view, getPos, options.block
                ? parseBlockMathSource(raw.value)
                : parseInlineMathSource(raw.value));
            // Auto-exit on input only fires for block math: typing the closing
            // `$$` line is a clear "I am done" signal. Inline math, by contrast,
            // is often re-edited after the closing `$` is already in place
            // (e.g. user opens a closed inline math and adds characters); an
            // auto-exit on every keystroke would trap them out of the node.
            if (options.block && isClosedMathSource(raw.value, options.block) && isCaretAtEnd(raw)) {
                queueMicrotask(exitToNextParagraph);
            }
        });
        raw.addEventListener('blur', () => setEditing(false));
        raw.addEventListener('keydown', event => {
            const keyEvent = event as KeyboardEvent;
            if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                setEditing(false);
                view.focus();
                return;
            }
            if (keyEvent.key === 'Enter' && isClosedMathSource(raw.value, options.block) && isCaretAtMathBoundary(raw, options.block)) {
                keyEvent.preventDefault();
                exitToNextParagraph(exitDirectionForMathCaret(raw, options.block));
                return;
            }
            if (keyEvent.key === 'ArrowUp' && isClosedMathSource(raw.value, options.block)
                && !raw.value.slice(0, raw.selectionStart ?? 0).includes('\n')) {
                keyEvent.preventDefault();
                exitToNextParagraph('above');
                return;
            }
            if (keyEvent.key === 'ArrowDown' && isClosedMathSource(raw.value, options.block)
                && !raw.value.slice(raw.selectionEnd ?? raw.value.length).includes('\n')) {
                keyEvent.preventDefault();
                exitToNextParagraph('below');
                return;
            }
            if (keyEvent.key === 'ArrowLeft' && isClosedMathSource(raw.value, options.block)
                && (raw.selectionStart ?? 0) === 0 && (raw.selectionEnd ?? 0) === 0) {
                keyEvent.preventDefault();
                exitToNextParagraph('above');
                return;
            }
            if (keyEvent.key === 'ArrowRight' && isClosedMathSource(raw.value, options.block)
                && (raw.selectionStart ?? 0) === raw.value.length && (raw.selectionEnd ?? 0) === raw.value.length) {
                keyEvent.preventDefault();
                exitToNextParagraph('below');
                return;
            }
            if (!options.block && keyEvent.key === 'Enter') {
                keyEvent.preventDefault();
                setEditing(false);
                view.focus();
            }
            if (options.block && keyEvent.key === 'Enter' && (keyEvent.metaKey || keyEvent.ctrlKey)) {
                keyEvent.preventDefault();
                setEditing(false);
                view.focus();
            }
        });
        raw.addEventListener('mousedown', event => event.stopPropagation());
        raw.addEventListener('click', event => event.stopPropagation());
        dom.addEventListener('notes-enter-editing', (event: Event) => {
            setEditing(true);
            const detail = (event as CustomEvent<{ caretPosition?: 'start' | 'end' }>).detail;
            const target = detail?.caretPosition === 'start' ? 0 : raw.value.length;
            raw.setSelectionRange(target, target);
        });

        sync();

        return {
            dom,
            update: nextNode => {
                if (nextNode.type !== currentNode.type) return false;
                currentNode = nextNode;
                sync();
                return true;
            },
            selectNode: () => {
                dom.dataset.selected = 'true';
            },
            deselectNode: () => {
                dom.dataset.selected = 'false';
            },
            stopEvent: event =>
                event.target === raw
                || raw.contains(event.target as Node)
                || event.type === 'pointerdown'
                || event.type === 'mousedown'
                || event.type === 'click',
            ignoreMutation: mutation =>
                mutation.target === dom
                || mutation.target === raw
                || raw.contains(mutation.target as Node)
                || rendered.contains(mutation.target),
        };
    };
}

export const notesMathInlineSchema = $nodeSchema(mathInlineId, ctx => ({
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
        value: { default: '', validate: 'string' },
    },
    parseDOM: [
        {
            tag: `span[data-type="${mathInlineId}"]`,
            getAttrs: dom => ({
                value: dom instanceof HTMLElement ? dom.dataset.value ?? '' : '',
            }),
        },
    ],
    toDOM: node => {
        const code = node.attrs.value as string;
        const dom = document.createElement('span');
        dom.dataset.type = mathInlineId;
        dom.dataset.value = code;
        renderKatex(dom, code, ctx.get(notesMilkdownKatexOptionsCtx.key));
        return dom;
    },
    parseMarkdown: {
        match: node => node.type === 'inlineMath',
        runner: (state, node, type) => {
            state.addNode(type, { value: node.value as string });
        },
    },
    toMarkdown: {
        match: node => node.type.name === mathInlineId,
        runner: (state, node) => {
            state.addNode('inlineMath', undefined, node.attrs.value as string);
        },
    },
}));

export const notesMathBlockSchema = $nodeSchema(mathBlockId, ctx => ({
    content: 'text*',
    group: 'block',
    marks: '',
    defining: true,
    atom: true,
    isolating: true,
    attrs: {
        value: { default: '', validate: 'string' },
    },
    parseDOM: [
        {
            tag: `div[data-type="${mathBlockId}"]`,
            preserveWhitespace: 'full',
            getAttrs: dom => ({
                value: dom instanceof HTMLElement ? dom.dataset.value ?? '' : '',
            }),
        },
    ],
    toDOM: node => {
        const code = node.attrs.value as string;
        const dom = document.createElement('div');
        dom.dataset.type = mathBlockId;
        dom.dataset.value = code;
        renderKatex(dom, code, ctx.get(notesMilkdownKatexOptionsCtx.key));
        return dom;
    },
    parseMarkdown: {
        match: node => node.type === 'math',
        runner: (state, node, type) => {
            state.addNode(type, { value: node.value as string });
        },
    },
    toMarkdown: {
        match: node => node.type.name === mathBlockId,
        runner: (state, node) => {
            state.addNode('math', undefined, node.attrs.value as string);
        },
    },
}));

export const notesMathInlineView = $view(notesMathInlineSchema.node, ctx =>
    createMathView({
        block: false,
        render: (target, code) => renderKatex(target, code, ctx.get(notesMilkdownKatexOptionsCtx.key)),
    }),
);

export const notesMathBlockView = $view(notesMathBlockSchema.node, ctx =>
    createMathView({
        block: true,
        render: (target, code) => renderKatex(target, code, ctx.get(notesMilkdownKatexOptionsCtx.key)),
    }),
);

export const notesMathInlineInputRule = $inputRule(ctx =>
    new InputRule(/(?:\$)([^$]+)(?:\$)$/, (state, match, start, end) => {
        const expression = match[1]?.trim();
        if (!expression) return null;
        return state.tr.replaceWith(start, end, notesMathInlineSchema.type(ctx).create({ value: expression }));
    }),
);

export const notesMathBlockInputRule = $inputRule(ctx =>
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
        const $start = state.doc.resolve(start);
        const canReplace = $start.node(-1).canReplaceWith(
            $start.index(-1),
            $start.indexAfter(-1),
            notesMathBlockSchema.type(ctx),
        );
        if (!canReplace) return null;
        return state.tr.delete(start, end).setBlockType(start, start, notesMathBlockSchema.type(ctx));
    }),
);

export const notesMilkdownMath: MilkdownPlugin[] = [
    notesRemarkMathPlugin,
    notesMilkdownKatexOptionsCtx,
    notesMathInlineSchema,
    notesMathBlockSchema,
    notesMathInlineView,
    notesMathBlockView,
    notesMathBlockInputRule,
    notesMathInlineInputRule,
].flat();
