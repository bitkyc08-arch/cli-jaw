import type { EditorView } from '@codemirror/view';
import { uploadNoteAsset } from '../../api';
import { firstClipboardImage } from './clipboard-images';

export type NotesImagePasteOptions = {
    notePath: string;
    onError?: (error: Error) => void;
};

function errorFromUnknown(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export async function uploadClipboardImageMarkdown(notePath: string, data: DataTransfer | null): Promise<string | null> {
    const image = firstClipboardImage(data);
    if (!image) return null;
    const result = await uploadNoteAsset(notePath, image);
    return result.markdown;
}

export function handleClipboardImagePaste(
    event: ClipboardEvent,
    view: EditorView,
    options: NotesImagePasteOptions,
): boolean {
    const image = firstClipboardImage(event.clipboardData);
    if (!image) return false;
    const textFallback = event.clipboardData?.getData('text/plain') ?? '';
    event.preventDefault();
    void uploadNoteAsset(options.notePath, image)
        .then(result => {
            view.dispatch(view.state.replaceSelection(result.markdown));
        })
        .catch(error => {
            if (textFallback) view.dispatch(view.state.replaceSelection(textFallback));
            options.onError?.(errorFromUnknown(error));
        });
    return true;
}
