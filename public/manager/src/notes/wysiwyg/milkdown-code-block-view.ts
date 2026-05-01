import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';

function codeText(node: ProseMirrorNode): string {
    return node.textContent;
}

function codeLanguage(node: ProseMirrorNode): string {
    return String(node.attrs.language ?? '');
}

function fencedCodeSource(node: ProseMirrorNode): string {
    const language = codeLanguage(node);
    return `\`\`\`${language}\n${codeText(node)}\n\`\`\``;
}

function parseFencedCodeSource(source: string): { language: string; code: string } {
    const normalized = source.replace(/\r\n?/g, '\n');
    const match = normalized.match(/^```([^\n`]*)\n?([\s\S]*?)\n?```\s*$/);
    if (!match) return { language: '', code: normalized };
    return {
        language: match[1]?.trim().toLowerCase().replace(/[^a-z0-9_+-]/g, '') ?? '',
        code: match[2] ?? '',
    };
}

function updateCodeBlockNode(view: EditorView, getPos: () => number | undefined, source: string): void {
    const pos = getPos();
    if (pos === undefined) return;
    const current = view.state.doc.nodeAt(pos);
    if (!current) return;
    const parsed = parseFencedCodeSource(source);
    const text = parsed.code ? view.state.schema.text(parsed.code) : undefined;
    const next = current.type.create({ ...current.attrs, language: parsed.language }, text, current.marks);
    view.dispatch(view.state.tr.replaceWith(pos, pos + current.nodeSize, next).scrollIntoView());
}

function createCodeBlockView(): NodeViewConstructor {
    return (node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        let currentNode = node;
        const dom = document.createElement('div');
        const rendered = document.createElement('div');
        const header = document.createElement('div');
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const raw = document.createElement('textarea');

        dom.className = 'notes-code-source-node';
        rendered.className = 'notes-code-rendered';
        header.className = 'notes-code-source-header';
        raw.className = 'notes-code-raw';
        raw.setAttribute('aria-label', 'Edit fenced code source');
        pre.append(code);
        rendered.append(header, pre);
        dom.append(rendered, raw);

        function sync(): void {
            const language = codeLanguage(currentNode);
            const source = codeText(currentNode);
            dom.dataset.language = language;
            pre.dataset.language = language;
            header.textContent = language || 'code';
            code.textContent = source;
            if (dom.dataset.editing !== 'true') raw.value = fencedCodeSource(currentNode);
        }

        function setEditing(editing: boolean): void {
            dom.dataset.editing = editing ? 'true' : 'false';
            if (editing) {
                raw.value = fencedCodeSource(currentNode);
                raw.focus();
                raw.select();
            }
        }

        dom.addEventListener('click', () => setEditing(true));
        raw.addEventListener('input', () => updateCodeBlockNode(view, getPos, raw.value));
        raw.addEventListener('blur', () => setEditing(false));
        raw.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                view.focus();
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                setEditing(false);
                view.focus();
            }
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
            stopEvent: event => event.target === raw || raw.contains(event.target as Node),
            ignoreMutation: mutation => mutation.target === raw || rendered.contains(mutation.target),
        };
    };
}

export const notesCodeBlockSourceView = $view(codeBlockSchema.node, () => createCodeBlockView());

export const notesMilkdownCodeBlockView: MilkdownPlugin[] = [
    notesCodeBlockSourceView,
].flat();
