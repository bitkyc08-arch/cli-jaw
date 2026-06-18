import { useEffect, useRef } from 'react';
import type { JawCeoController } from './useJawCeo';
import type { JawCeoVoiceController } from './useJawCeoVoice';
import { JawCeoConsoleBody } from './JawCeoConsolePanels';
import { JawCeoTabs } from './JawCeoTabs';
import { useJawCeoConsoleModel } from './useJawCeoConsoleModel';

const RefreshIcon = () => (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" />
        <path d="M13.2 3.2v3.2H10" />
    </svg>
);

const CloseIcon = () => (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
);

function voiceFooterLabel(status: JawCeoVoiceController['status']): string {
    if (status === 'connecting') return 'connecting';
    if (status === 'active') return 'listening';
    if (status === 'silent') return 'silent';
    if (status === 'paused') return 'paused';
    if (status === 'sleeping') return 'sleeping';
    if (status === 'disabled') return 'disabled';
    if (status === 'error') return 'error';
    return 'idle';
}

function canPauseVoice(status: JawCeoVoiceController['status']): boolean {
    return status === 'active' || status === 'connecting' || status === 'silent';
}

function voiceTone(status: JawCeoVoiceController['status']): string {
    if (status === 'active' || status === 'connecting' || status === 'silent') return 'live';
    if (status === 'paused' || status === 'sleeping') return 'paused';
    if (status === 'disabled' || status === 'error') return 'issue';
    return 'idle';
}

export function JawCeoConsole(props: {
    open: boolean;
    selectedPort: number | null;
    ceo: JawCeoController;
    voice: JawCeoVoiceController;
    onClose: () => void;
    onOpenWorker: (port: number, messageId?: number) => void;
}) {
    const closeRef = useRef<HTMLButtonElement | null>(null);
    const model = useJawCeoConsoleModel({ ceo: props.ceo });

    useEffect(() => {
        if (!props.open) return undefined;
        closeRef.current?.focus();
        function onKeyDown(event: KeyboardEvent): void {
            if (event.key !== 'Escape') return;
            if (canPauseVoice(props.voice.status)) {
                event.preventDefault();
                void props.voice.stop();
                return;
            }
            props.onClose();
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [props]);

    if (!props.open) return null;
    const target = props.selectedPort == null ? 'Dashboard' : `Worker :${props.selectedPort}`;
    const voiceLabel = voiceFooterLabel(props.voice.status);
    return (
        <div className="jaw-ceo-console" role="region" aria-label="Jaw CEO console" data-surface-owner="ceo-orchestration-control">
            <header className="jaw-ceo-console-header">
                <div className="jaw-ceo-console-titlebar">
                    <span className={`jaw-ceo-console-mark status-${props.voice.status}`} aria-hidden="true">CEO</span>
                    <div className="jaw-ceo-console-heading">
                        <span>Dashboard coordinator</span>
                        <h3>Jaw CEO</h3>
                    </div>
                </div>
                <div className="jaw-ceo-console-header-actions">
                    <button type="button" className="jaw-ceo-icon-btn" onClick={() => void props.ceo.refresh()} aria-label="Refresh Jaw CEO"><RefreshIcon /></button>
                    <button ref={closeRef} type="button" className="jaw-ceo-console-close" onClick={props.onClose} aria-label="Close Jaw CEO"><CloseIcon /></button>
                </div>
                <div className="jaw-ceo-console-summary" aria-label="Jaw CEO status summary">
                    <span>{target}</span>
                    <span>Single session</span>
                    <span className={`voice-tone-${voiceTone(props.voice.status)}`}>Voice {voiceLabel}</span>
                </div>
            </header>
            <JawCeoTabs active={model.tab} onChange={model.setTab} />
            <div className="jaw-ceo-console-body"><JawCeoConsoleBody model={model} ceo={props.ceo} voice={props.voice} selectedPort={props.selectedPort} onOpenWorker={props.onOpenWorker} /></div>
            <footer className={`jaw-ceo-console-footer voice-${props.voice.status}`}>
                <div className="jaw-ceo-realtime-status">
                    <span className="jaw-ceo-realtime-dot" aria-hidden="true" />
                    <span>Voice: {voiceLabel}{props.voice.error ? ` - ${props.voice.error}` : ''}</span>
                    {props.voice.lastTranscript ? <small>{props.voice.lastTranscript}</small> : props.voice.lastEventType ? <small>{props.voice.lastEventType}</small> : null}
                </div>
                <button type="button" className="jaw-ceo-voice-action" onClick={() => canPauseVoice(props.voice.status) ? void props.voice.stop() : void props.voice.talk()}>{canPauseVoice(props.voice.status) ? 'Stop voice' : 'Start voice'}</button>
            </footer>
        </div>
    );
}
