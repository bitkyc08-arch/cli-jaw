import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstanceOriginClient } from '../../providers/api-provider.tsx';

export type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error';

interface VoiceRecorderOptions {
    client: InstanceOriginClient | null;
    onTranscript(text: string): void;
    permissionTimeoutMs?: number;
}

function stopStream(stream: MediaStream | null): void {
    stream?.getTracks().forEach(track => track.stop());
}

export function useVoiceRecorder({ client, onTranscript, permissionTimeoutMs = 10_000 }: VoiceRecorderOptions) {
    const [state, setState] = useState<VoiceState>('idle');
    const [error, setError] = useState<string | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const abortRef = useRef<AbortController | null>(null);
    const mountedRef = useRef(true);

    const cleanup = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        recorderRef.current = null;
        stopStream(streamRef.current);
        streamRef.current = null;
        chunksRef.current = [];
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            cleanup();
        };
    }, [cleanup, client]);

    const start = useCallback(async () => {
        if (!client || state !== 'idle') return;
        setError(null);
        setState('requesting');
        let timedOut = false;
        let timer = 0;
        const mediaPromise = navigator.mediaDevices.getUserMedia({ audio: true });
        try {
            const stream = await Promise.race([
                mediaPromise,
                new Promise<never>((_, reject) => {
                    timer = window.setTimeout(() => {
                        timedOut = true;
                        reject(new Error('Microphone permission timed out'));
                    }, permissionTimeoutMs);
                }),
            ]);
            window.clearTimeout(timer);
            if (!mountedRef.current) {
                stopStream(stream);
                return;
            }
            streamRef.current = stream;
            const recorder = new MediaRecorder(stream);
            recorderRef.current = recorder;
            chunksRef.current = [];
            recorder.ondataavailable = event => {
                if (event.data.size) chunksRef.current.push(event.data);
            };
            /*
             * A recorder can fail asynchronously (device removed, tab throttled).
             * Without this the recorder goes inactive while React still says
             * 'recording', and Stop returns immediately because stop() on an
             * inactive recorder is a no-op — the UI is then stuck with the mic
             * held open.
             */
            recorder.onerror = () => {
                stopStream(streamRef.current);
                streamRef.current = null;
                recorderRef.current = null;
                if (!mountedRef.current) return;
                setError('Recording stopped unexpectedly');
                setState('error');
            };
            recorder.start();
            setState('recording');
        } catch (cause) {
            window.clearTimeout(timer);
            if (timedOut) mediaPromise.then(stopStream).catch(() => undefined);
            // The stream may already be held: permission succeeded and only the
            // recorder construction or start() threw. Release the mic now rather
            // than leaving it live until the user happens to dismiss the error.
            stopStream(streamRef.current);
            streamRef.current = null;
            recorderRef.current = null;
            if (!mountedRef.current) return;
            setError(cause instanceof Error ? cause.message : 'Microphone unavailable');
            setState('error');
        }
    }, [client, permissionTimeoutMs, state]);

    const stop = useCallback(async () => {
        const recorder = recorderRef.current;
        if (!client || !recorder || recorder.state === 'inactive') return;
        setState('transcribing');
        const stopped = new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }));
        recorder.stop();
        await stopped;
        stopStream(streamRef.current);
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        const abortController = new AbortController();
        abortRef.current = abortController;
        try {
            const result = await client.transcribeVoice(blob, { signal: abortController.signal });
            if (!mountedRef.current || abortController.signal.aborted) return;
            onTranscript(result.text.trim());
            setState('idle');
        } catch (cause) {
            if (!mountedRef.current || abortController.signal.aborted) return;
            setError(cause instanceof Error ? cause.message : 'Transcription failed');
            setState('error');
        } finally {
            if (abortRef.current === abortController) abortRef.current = null;
            recorderRef.current = null;
        }
    }, [client, onTranscript]);

    const reset = useCallback(() => {
        cleanup();
        setError(null);
        setState('idle');
    }, [cleanup]);

    return { state, error, start, stop, reset, cleanup };
}
