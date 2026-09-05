import type { ActivityTranscriptItem } from '../../../src/cli/tui/activity.js';
import { appendActivityFallbackPreview, settleActivityFallbackPreviews } from '../../../src/cli/tui/transcript.js';
import { safeActivityTerminalText, wrapActivityTerminalText } from '../../../src/cli/tui/activity-terminal-text.js';
import { closeActivityLinear } from '../../../src/cli/tui/activity-linear.js';
import type { TuiContext } from './types.js';

/** Fallback output uses its admitted run, never the shared legacy stream sink. */
export function handleActivityFallbackOutput(
    ctx: TuiContext, activity: ActivityTranscriptItem, text: string,
    options: Parameters<typeof appendActivityFallbackPreview>[3] = {},
): void {
    const preview = appendActivityFallbackPreview(ctx.store.transcript, activity.key, text, options);
    if (!preview) return;
    if (preview.omitted) {
        activity.displayGap = true;
        activity.degraded = true;
        activity.revision++;
        if (ctx.displayMode === 'line' && !activity.lineLimitReported) {
            process.stdout.write('\nProvisional output limited; awaiting the full final answer.\n');
            activity.lineLimitReported = true;
        }
    }
    if (ctx.displayMode === 'line' && preview.item) {
        // Sanitize accumulated input so split terminal control strings stay hidden.
        const previous = safeActivityTerminalText(preview.previousText);
        const current = safeActivityTerminalText(preview.item.text);
        const delta = preview.item.activityPreviewPrinted && current.startsWith(previous) ? current.slice(previous.length) : current;
        if (delta) {
            process.stdout.write(closeActivityLinear(activity) + '\nProvisional output (awaiting final):\n'
                + wrapActivityTerminalText(delta, process.stdout.columns || 80).join('\n') + '\n');
            preview.item.activityPreviewPrinted = true;
        }
    }
    ctx.requestFrame?.();
}

export function settleActivityFallbackOutput(ctx: TuiContext, key: string, finalText: string | null): void {
    const printed = settleActivityFallbackPreviews(ctx.store.transcript, key);
    if (!printed || ctx.displayMode !== 'line') return;
    process.stdout.write(finalText === null ? '\n[Provisional output ended; no final answer was returned.]\n'
        : finalText === '' ? '\n[Provisional output ended; the final answer is empty.]\n'
            : '\n[Provisional output ended; final answer follows.]\n');
}
