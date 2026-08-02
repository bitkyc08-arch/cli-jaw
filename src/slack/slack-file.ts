// ─── Slack File Upload ───────────────────────────────
// files.upload was SUNSET on 2025-11-12. The supported flow is:
//   1. files.getUploadURLExternal  -> { upload_url, file_id }
//   2. POST the bytes to upload_url (multipart, NOT a Slack API method:
//      no Authorization header, no ok:false envelope)
//   3. files.completeUploadExternal -> attaches file to a conversation
// Source: docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RemoteTarget } from '../messaging/types.js';
import { slackApi, describeSlackError, redactSlackTokens, slackFailure, type SlackFetch } from './api.js';
import { redactOutboundText } from '../messaging/redact.js';

// Slack's per-file ceiling is 1 GB, but a chat transport has no business
// streaming that. 50 MiB matches the inbound attachment cap the Discord
// transport already enforces.
export const SLACK_FILE_LIMIT = 50 * 1024 * 1024;

export function validateSlackFileSize(size: number) {
    if (size > SLACK_FILE_LIMIT) {
        throw Object.assign(
            new Error(`File exceeds Slack transport limit: ${(size / 1024 / 1024).toFixed(1)} MiB (max 50 MiB)`),
            { statusCode: 413 },
        );
    }
}

export async function sendSlackFile(
    token: string,
    target: RemoteTarget,
    filePath: string,
    options: { caption?: string; fetchImpl?: SlackFetch } = {},
): Promise<{ ok: boolean; error?: string; status?: number }> {
    const doFetch = options.fetchImpl || fetch;
    let fileStat;
    try {
        fileStat = await stat(filePath);
    } catch {
        return { ok: false, error: `File not found: ${filePath}`, status: 400 };
    }
    validateSlackFileSize(fileStat.size);
    if (fileStat.size === 0) {
        // Slack rejects a zero-length reservation with `missing_argument`,
        // which reads as a client bug. Fail locally with something actionable.
        return slackFailure('Cannot upload an empty file to Slack', 400);
    }
    const filename = basename(filePath);

    // Step 1 — reserve an upload URL (POST, form-encoded per Slack docs).
    const reserve = await slackApi<{ upload_url?: string; file_id?: string }>(
        token,
        'files.getUploadURLExternal',
        { filename, length: fileStat.size },
        { fetchImpl: doFetch, form: true },
    );
    const uploadUrl = reserve.data?.upload_url;
    const fileId = reserve.data?.file_id;
    if (!reserve.ok || !uploadUrl || !fileId) {
        return slackFailure(describeSlackError(reserve.error || 'upload_url_missing'), reserve.status);
    }

    // Step 2 — POST the bytes to the returned URL.
    try {
        const buffer = await readFile(filePath);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(buffer)]), filename);
        const upload = await doFetch(uploadUrl, { method: 'POST', body: form });
        if (!upload.ok) {
            return { ok: false, error: `Slack upload failed (${upload.status})`, status: upload.status };
        }
    } catch (error) {
        // The presigned upload URL is a temporary capability: a thrown fetch
        // error routinely embeds it, and this string reaches both API responses
        // and the image-relay log.
        return slackFailure(redactSlackTokens((error as Error).message), 502);
    }

    // Step 3 — attach it to the conversation (thread-aware).
    const complete = await slackApi(
        token,
        'files.completeUploadExternal',
        {
            files: [{ id: fileId, title: filename }],
            channel_id: target.targetId,
            ...(target.threadId ? { thread_ts: target.threadId } : {}),
            ...(options.caption?.trim() ? { initial_comment: redactOutboundText(options.caption.trim()) } : {}),
        },
        { fetchImpl: doFetch },
    );
    if (!complete.ok) {
        return slackFailure(describeSlackError(complete.error), complete.status);
    }
    return { ok: true };
}
