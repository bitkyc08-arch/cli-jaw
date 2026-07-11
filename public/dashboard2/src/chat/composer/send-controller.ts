import type { AttachmentUploadResponse, InstanceOriginClient, MessageResponse } from '../../providers/api-provider.tsx';
import { appendAttachmentPaths, type ComposerAttachment } from './attachments.ts';

export type SendSource = 'button' | 'enter' | 'command';

export interface SendSnapshot {
    draft: string;
    attachments: readonly ComposerAttachment[];
    source: SendSource;
}

export interface SendSuccess {
    snapshot: SendSnapshot;
    prompt: string;
    response: MessageResponse;
    uploads: AttachmentUploadResponse[];
}

export interface SendController {
    send(snapshot: SendSnapshot): Promise<SendSuccess>;
    abort(): void;
    isInFlight(): boolean;
}

export class AttachmentUploadError extends Error {
    constructor(public readonly identity: string, cause: unknown) {
        super(cause instanceof Error ? cause.message : 'Attachment upload failed');
        this.name = 'AttachmentUploadError';
    }
}

export function createSendController(client: InstanceOriginClient): SendController {
    let active: Promise<SendSuccess> | null = null;
    let abortController: AbortController | null = null;

    const send = (snapshot: SendSnapshot): Promise<SendSuccess> => {
        if (active) return active;
        if (!snapshot.draft.trim() && !snapshot.attachments.some(item => item.status !== 'error')) {
            return Promise.reject(new Error('Message is empty'));
        }
        abortController = new AbortController();
        const signal = abortController.signal;
        active = (async () => {
            const uploadable = snapshot.attachments.filter(item => item.status !== 'error');
            const uploads = await Promise.all(uploadable.map(async item => {
                try {
                    return await client.uploadAttachment(item.file, { signal });
                } catch (cause) {
                    throw new AttachmentUploadError(item.identity, cause);
                }
            }));
            const prompt = appendAttachmentPaths(snapshot.draft, uploads.map(upload => upload.path));
            const response = await client.sendMessage(prompt, { signal });
            return { snapshot, prompt, response, uploads };
        })().finally(() => {
            active = null;
            abortController = null;
        });
        return active;
    };

    return {
        send,
        abort: () => abortController?.abort(),
        isInFlight: () => active !== null,
    };
}
