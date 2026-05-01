import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { keymap } from '@milkdown/kit/prose/keymap';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

const BLOCK_NODE_TYPES = new Set(['code_block', 'math_block']);
const INLINE_NODE_TYPES = new Set(['math_inline']);

function dispatchEnterEditing(view: import('@milkdown/kit/prose/view').EditorView, pos: number, caretPosition: 'start' | 'end'): boolean {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    dom.dispatchEvent(new CustomEvent('notes-enter-editing', { bubbles: false, detail: { caretPosition } }));
    return true;
}

function adjacentBlock(state: import('@milkdown/kit/prose/state').EditorState, side: 'prev' | 'next'): { node: import('@milkdown/kit/prose/model').Node; pos: number } | null {
    if (!(state.selection instanceof TextSelection)) return null;
    const { $cursor } = state.selection;
    if (!$cursor) return null;
    if (side === 'prev' && $cursor.parentOffset !== 0) return null;
    if (side === 'next' && $cursor.parentOffset !== $cursor.parent.content.size) return null;

    const depth = $cursor.depth;
    if (depth < 1) return null;
    const containerDepth = depth - 1;
    const index = $cursor.index(containerDepth);
    const container = $cursor.node(containerDepth);
    if (side === 'prev') {
        if (index === 0) return null;
        const node = container.child(index - 1);
        if (!BLOCK_NODE_TYPES.has(node.type.name)) return null;
        const pos = $cursor.before(depth) - node.nodeSize;
        return { node, pos };
    }
    if (index >= container.childCount - 1) return null;
    const node = container.child(index + 1);
    if (!BLOCK_NODE_TYPES.has(node.type.name)) return null;
    const pos = $cursor.after(depth);
    return { node, pos };
}

export const notesBlockBoundaryKeymap = $prose(() => keymap({
    'Backspace': (state, _dispatch, view) => {
        if (!(state.selection instanceof TextSelection)) return false;
        const { $cursor } = state.selection;
        if (!$cursor) return false;
        if ($cursor.parentOffset !== 0) return false;

        const depth = $cursor.depth;
        if (depth < 1) return false;
        const containerDepth = depth - 1;
        const indexInContainer = $cursor.index(containerDepth);
        if (indexInContainer === 0) return false;

        const container = $cursor.node(containerDepth);
        const prevNode = container.child(indexInContainer - 1);
        if (!BLOCK_NODE_TYPES.has(prevNode.type.name)) return false;

        if (!view) return true;

        // Do NOT create a NodeSelection — that paints the whole block as
        // "selected" (PM's ProseMirror-selectednode overlay) and traps the
        // user. Instead synchronously dispatch the editing event on the prev
        // block's DOM; the node view's listener focuses its raw textarea and
        // places the caret at the end of the source.
        const prevNodePos = $cursor.before(depth) - prevNode.nodeSize;
        const dom = view.nodeDOM(prevNodePos);
        if (dom instanceof HTMLElement) {
            dom.dispatchEvent(new CustomEvent('notes-enter-editing', { bubbles: false }));
        }
        return true;
    },

    'Enter': (state, dispatch) => {
        if (!(state.selection instanceof NodeSelection)) return false;
        const node = state.selection.node;
        if (!BLOCK_NODE_TYPES.has(node.type.name)) return false;
        if (!dispatch) return true;

        const after = state.selection.from + node.nodeSize;
        const paragraph = state.schema.nodes.paragraph?.create();
        if (!paragraph) return false;

        const tr = state.tr.insert(after, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        dispatch(tr.scrollIntoView());
        return true;
    },

    'ArrowDown': (state, _dispatch, view) => {
        if (!view) return false;
        if (!view.endOfTextblock('down')) return false;
        const next = adjacentBlock(state, 'next');
        if (!next) return false;
        return dispatchEnterEditing(view, next.pos, 'start');
    },

    'ArrowUp': (state, _dispatch, view) => {
        if (!view) return false;
        if (!view.endOfTextblock('up')) return false;
        const prev = adjacentBlock(state, 'prev');
        if (!prev) return false;
        return dispatchEnterEditing(view, prev.pos, 'end');
    },

    'ArrowRight': (state, _dispatch, view) => {
        if (!view) return false;
        if (!(state.selection instanceof TextSelection)) return false;
        const { $cursor } = state.selection;
        if (!$cursor) return false;

        // Inline atom entry: cursor is right before an inline math node.
        const nodeAfter = $cursor.nodeAfter;
        if (nodeAfter && INLINE_NODE_TYPES.has(nodeAfter.type.name)) {
            return dispatchEnterEditing(view, $cursor.pos, 'start');
        }

        if ($cursor.parentOffset !== $cursor.parent.content.size) return false;
        const next = adjacentBlock(state, 'next');
        if (!next) return false;
        return dispatchEnterEditing(view, next.pos, 'start');
    },

    'ArrowLeft': (state, _dispatch, view) => {
        if (!view) return false;
        if (!(state.selection instanceof TextSelection)) return false;
        const { $cursor } = state.selection;
        if (!$cursor) return false;

        // Inline atom entry: cursor is right after an inline math node.
        const nodeBefore = $cursor.nodeBefore;
        if (nodeBefore && INLINE_NODE_TYPES.has(nodeBefore.type.name)) {
            return dispatchEnterEditing(view, $cursor.pos - nodeBefore.nodeSize, 'end');
        }

        if ($cursor.parentOffset !== 0) return false;
        const prev = adjacentBlock(state, 'prev');
        if (!prev) return false;
        return dispatchEnterEditing(view, prev.pos, 'end');
    },
}));

export const notesMilkdownBlockKeymap: MilkdownPlugin[] = [
    notesBlockBoundaryKeymap,
].flat();
