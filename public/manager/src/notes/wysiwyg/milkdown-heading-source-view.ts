import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { headingSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseMirrorNode, NodeType } from '@milkdown/kit/prose/model';
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView, NodeViewConstructor, ViewMutationRecord } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';

const MIN_HEADING_LEVEL = 1;
const MAX_HEADING_LEVEL = 6;
const HEADING_SOURCE_UPDATED_EVENT = 'notes-heading-source-updated';

function headingLevel(node: ProseMirrorNode): number {
    const raw = Number(node.attrs.level);
    if (!Number.isFinite(raw)) return MIN_HEADING_LEVEL;
    return Math.min(MAX_HEADING_LEVEL, Math.max(MIN_HEADING_LEVEL, Math.trunc(raw)));
}

function markerForLevel(level: number): string {
    return '#'.repeat(level);
}

function parseHeadingMarker(marker: string): number | null {
    const trimmed = marker.trim();
    if (trimmed === '') return 0;
    if (!/^#{1,6}$/.test(trimmed)) return null;
    return trimmed.length;
}

function textSelectionNear(view: EditorView, pos: number): Selection {
    return TextSelection.near(view.state.doc.resolve(Math.min(pos, view.state.doc.content.size)), 1);
}

function updateHeadingLevel(
    view: EditorView,
    getPos: () => number | undefined,
    node: ProseMirrorNode,
    level: number,
): void {
    const pos = getPos();
    if (pos === undefined) return;
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== 'heading') return;

    const paragraph = view.state.schema.nodes.paragraph;
    const tr = level === 0 && paragraph
        ? view.state.tr.setNodeMarkup(pos, paragraph as NodeType)
        : view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, level });
    if (level === 0) tr.setSelection(textSelectionNear(view, pos + 1));
    else tr.setSelection(view.state.selection.map(tr.doc, tr.mapping));
    view.dispatch(tr.scrollIntoView());
    view.dom.dispatchEvent(new CustomEvent(HEADING_SOURCE_UPDATED_EVENT, { bubbles: true }));
}

function createHeadingSourceView(): NodeViewConstructor {
    return (node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        let currentNode = node;
        const dom = document.createElement('div');
        const marker = document.createElement('input');
        const content = document.createElement('span');

        dom.className = 'notes-heading-source-node';
        marker.className = 'notes-heading-source-marker';
        marker.type = 'text';
        marker.inputMode = 'text';
        marker.autocomplete = 'off';
        marker.spellcheck = false;
        marker.setAttribute('aria-label', 'Edit heading marker');
        content.className = 'notes-heading-source-content';
        dom.append(marker, content);

        function sync(): void {
            const level = headingLevel(currentNode);
            dom.dataset.level = String(level);
            dom.setAttribute('role', 'heading');
            dom.setAttribute('aria-level', String(level));
            dom.setAttribute('aria-label', currentNode.textContent);
            if (document.activeElement !== marker) marker.value = markerForLevel(level);
            marker.size = Math.max(1, marker.value.length);
        }

        function commitMarker(): void {
            const parsed = parseHeadingMarker(marker.value);
            if (parsed === null) {
                marker.value = markerForLevel(headingLevel(currentNode));
                sync();
                return;
            }
            updateHeadingLevel(view, getPos, currentNode, parsed);
            view.focus();
        }

        function focusMarker(event: Event): void {
            if (!marker.contains(event.target as Node)) return;
            event.preventDefault();
            event.stopPropagation();
            marker.focus();
            marker.select();
            window.setTimeout(() => {
                marker.focus();
                marker.select();
            }, 0);
        }

        function handleFocus(): void {
            dom.dataset.editing = 'true';
            marker.select();
        }

        function handleInput(): void {
            marker.size = Math.max(1, marker.value.length);
            const parsed = parseHeadingMarker(marker.value);
            if (parsed === null || parsed === 0 || parsed === headingLevel(currentNode)) return;
            updateHeadingLevel(view, getPos, currentNode, parsed);
        }

        function handleBlur(): void {
            dom.dataset.editing = 'false';
            commitMarker();
        }

        function handleKeydown(event: KeyboardEvent): void {
            event.stopPropagation();
            if (event.key === 'Enter') {
                event.preventDefault();
                marker.blur();
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                marker.value = markerForLevel(headingLevel(currentNode));
                dom.dataset.editing = 'false';
                marker.blur();
                view.focus();
            }
        }

        dom.addEventListener('pointerdown', focusMarker, { capture: true });
        dom.addEventListener('mousedown', focusMarker, { capture: true });
        dom.addEventListener('click', focusMarker, { capture: true });
        marker.addEventListener('focus', handleFocus);
        marker.addEventListener('input', handleInput);
        marker.addEventListener('blur', handleBlur);
        marker.addEventListener('keydown', handleKeydown);

        sync();

        return {
            dom,
            contentDOM: content,
            update(nextNode: ProseMirrorNode): boolean {
                if (nextNode.type.name !== 'heading') return false;
                currentNode = nextNode;
                sync();
                return true;
            },
            selectNode(): void {
                dom.dataset.selected = 'true';
            },
            deselectNode(): void {
                delete dom.dataset.selected;
            },
            stopEvent(event: Event): boolean {
                return marker.contains(event.target as Node)
                    || event.type === 'pointerdown'
                    || event.type === 'mousedown'
                    || event.type === 'click';
            },
            ignoreMutation(mutation: ViewMutationRecord): boolean {
                return mutation.target === dom
                    || marker.contains(mutation.target);
            },
            destroy(): void {
                dom.removeEventListener('pointerdown', focusMarker, { capture: true });
                dom.removeEventListener('mousedown', focusMarker, { capture: true });
                dom.removeEventListener('click', focusMarker, { capture: true });
                marker.removeEventListener('focus', handleFocus);
                marker.removeEventListener('input', handleInput);
                marker.removeEventListener('blur', handleBlur);
                marker.removeEventListener('keydown', handleKeydown);
            },
        };
    };
}

export const notesHeadingSourceView = $view(headingSchema.node, () => createHeadingSourceView());

export const notesMilkdownHeadingSourceView: MilkdownPlugin[] = [
    notesHeadingSourceView,
].flat();
