import { EditorSelection } from '@codemirror/state';
import type { Command, EditorView, KeyBinding } from '@codemirror/view';

export function wrapSelection(prefix: string, suffix: string = prefix): Command {
    return (view: EditorView): boolean => {
        const { state } = view;
        let touched = false;
        const tr = state.changeByRange(range => {
            touched = true;
            const text = state.sliceDoc(range.from, range.to);
            const insert = `${prefix}${text}${suffix}`;
            const newFrom = range.from + prefix.length;
            const newTo = newFrom + text.length;
            return {
                changes: { from: range.from, to: range.to, insert },
                range: range.empty
                    ? EditorSelection.cursor(newFrom)
                    : EditorSelection.range(newFrom, newTo),
            };
        });
        if (!touched) return false;
        view.dispatch(tr);
        return true;
    };
}

export const insertLink: Command = (view: EditorView): boolean => {
    const { state } = view;
    let touched = false;
    const tr = state.changeByRange(range => {
        touched = true;
        const text = state.sliceDoc(range.from, range.to);
        if (range.empty) {
            const insert = '[](url)';
            return {
                changes: { from: range.from, insert },
                range: EditorSelection.cursor(range.from + 1),
            };
        }
        const insert = `[${text}](url)`;
        const urlFrom = range.from + 1 + text.length + 2;
        const urlTo = urlFrom + 'url'.length;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.range(urlFrom, urlTo),
        };
    });
    if (!touched) return false;
    view.dispatch(tr);
    return true;
};

export function prefixSelectedLines(prefix: string): Command {
    return (view: EditorView): boolean => {
        const { state } = view;
        const changes = state.changeByRange(range => {
            const fromLine = state.doc.lineAt(range.from);
            const toLine = state.doc.lineAt(range.to);
            const inserts = [];
            for (let lineNumber = fromLine.number; lineNumber <= toLine.number; lineNumber += 1) {
                inserts.push({ from: state.doc.line(lineNumber).from, insert: prefix });
            }
            return {
                changes: inserts,
                range: EditorSelection.range(range.from + prefix.length, range.to + prefix.length),
            };
        });
        view.dispatch(changes);
        return true;
    };
}

export const insertCodeFence: Command = (view: EditorView): boolean => {
    const { state } = view;
    const selection = state.selection.main;
    const text = state.sliceDoc(selection.from, selection.to) || 'code';
    const insert = `\`\`\`\n${text}\n\`\`\``;
    view.dispatch({
        changes: { from: selection.from, to: selection.to, insert },
        selection: { anchor: selection.from + 4, head: selection.from + 4 + text.length },
    });
    return true;
};

export const markdownShortcutsKeymap: readonly KeyBinding[] = [
    { key: 'Mod-b', run: wrapSelection('**'), preventDefault: true },
    { key: 'Mod-i', run: wrapSelection('*'), preventDefault: true },
    { key: 'Mod-e', run: wrapSelection('`'), preventDefault: true },
    { key: 'Mod-k', run: insertLink, preventDefault: true },
];
