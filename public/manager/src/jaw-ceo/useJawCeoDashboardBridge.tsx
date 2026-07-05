import { useEffect, useMemo, useState } from 'react';
import type { ManagerEvent } from '../types';
import { JawCeoWorkbenchButton } from './JawCeoWorkbenchButton';
import { JawCeoVoiceOverlay } from './JawCeoVoiceOverlay';
import { useJawCeo } from './useJawCeo';
import { useJawCeoVoice } from './useJawCeoVoice';

function useDocumentVisible(): boolean {
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
    useEffect(() => {
        function onVisibilityChange(): void {
            setVisible(document.visibilityState === 'visible');
        }
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, []);
    return visible;
}

export function useJawCeoDashboardBridge(args: {
    selectedPort: number | null;
    managerEvents: ManagerEvent[];
    messageEvents: ManagerEvent[];
    onOpenWorker: (port: number, messageId?: number) => void;
}) {
    const [open, setOpen] = useState(false);
    const documentVisible = useDocumentVisible();
    const events = useMemo(() => [...args.managerEvents, ...args.messageEvents], [args.managerEvents, args.messageEvents]);
    const ceo = useJawCeo({ selectedPort: args.selectedPort, documentVisible, managerEvents: events });
    const sessionId = ceo.state.session.sessionId === 'pending' ? null : ceo.state.session.sessionId;
    const voice = useJawCeoVoice({
        selectedPort: args.selectedPort,
        ...(sessionId ? { sessionId } : {}),
        autoRead: ceo.state.session.autoRead,
        documentVisible,
        onTranscript: () => undefined,
        onSpokenCompletion: (completionKey) => { void ceo.ackCompletion(completionKey); },
    });
    const voiceActive = voice.status === 'active' || voice.status === 'connecting' || voice.status === 'silent';
    const workbenchControlsHidden = true;
    const workbenchButton = workbenchControlsHidden ? null : (
        <JawCeoWorkbenchButton
            open={open}
            voiceStatus={voice.status}
            busy={ceo.busy}
            error={ceo.error || voice.error}
            onOpenConsole={() => setOpen(prev => !prev)}
            onToggleVoice={() => { voiceActive ? void voice.stop() : void voice.talk(); }}
        />
    );
    const voiceOverlay = (
        <JawCeoVoiceOverlay
            status={voice.status}
            selectedPort={args.selectedPort}
            lastEventType={voice.lastEventType}
            lastTranscript={voice.lastTranscript}
            onStop={() => void voice.stop()}
        />
    );
    return {
        ceo,
        voice,
        open,
        setOpen,
        workbenchButton,
        voiceOverlay,
    };
}
