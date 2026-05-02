import { EditorView } from '@codemirror/view';
import { handleClipboardImagePaste, type NotesImagePasteOptions } from '../image-assets/insert-image-markdown';

function htmlToPlainText(html: string): string {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content.textContent || '';
}

export function richMarkdownPastePolicy(options?: NotesImagePasteOptions) {
    return EditorView.domEventHandlers({
        paste(event, view) {
            if (options && handleClipboardImagePaste(event, view, options)) return true;
            const text = event.clipboardData?.getData('text/plain');
            if (text) return false;
            const html = event.clipboardData?.getData('text/html');
            if (!html) return false;
            event.preventDefault();
            view.dispatch(view.state.replaceSelection(htmlToPlainText(html)));
            return true;
        },
    });
}
