import { useEffect } from 'react';
import type { JawCeoVoiceController } from './jaw-ceo/useJawCeoVoice';
import { allowedPreviewMessageOrigins, isAllowedPreviewMessage } from './preview-message-security';
import type { DashboardScanResult } from './types';

export function usePreviewSttLifecycle(
    voice: Pick<JawCeoVoiceController, 'status' | 'end'>,
    data: DashboardScanResult | null,
): void {
    useEffect(() => {
        const allowedOrigins = allowedPreviewMessageOrigins(data);
        function onPreviewSttLifecycle(event: MessageEvent): void {
            if (!isAllowedPreviewMessage(event, allowedOrigins)) return;
            const data = event.data as { type?: unknown; action?: unknown } | null;
            if (data?.type !== 'jaw-preview-stt-recording') return;
            if (data.action !== 'request') return;
            if (voice.status === 'active' || voice.status === 'silent' || voice.status === 'paused' || voice.status === 'connecting') {
                void voice.end();
            }
        }
        window.addEventListener('message', onPreviewSttLifecycle);
        return () => window.removeEventListener('message', onPreviewSttLifecycle);
    }, [data, voice.status, voice.end]);
}
