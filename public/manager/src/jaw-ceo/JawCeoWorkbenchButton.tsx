import type { JawCeoVoiceStatus } from './types';

const MicIcon = () => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2.5a2 2 0 0 0-2 2v3a2 2 0 0 0 4 0v-3a2 2 0 0 0-2-2Z" />
        <path d="M3.8 7.2a4.2 4.2 0 0 0 8.4 0" />
        <path d="M8 11.4v2.1" />
    </svg>
);

function voiceLabel(status: JawCeoVoiceStatus): string {
    if (status === 'active') return 'voice';
    if (status === 'connecting') return 'joining';
    if (status === 'silent') return 'listening';
    if (status === 'paused') return 'paused';
    if (status === 'sleeping') return 'sleep';
    if (status === 'disabled') return 'off';
    if (status === 'error') return 'error';
    return 'ready';
}

export function JawCeoWorkbenchButton(props: {
    open: boolean;
    voiceStatus: JawCeoVoiceStatus;
    busy: boolean;
    error: string | null;
    disabled?: boolean;
    onOpenConsole: () => void;
    onToggleVoice: () => void;
}) {
    const disabled = props.disabled === true;
    const active = !disabled && (props.voiceStatus === 'active' || props.voiceStatus === 'connecting' || props.voiceStatus === 'silent');
    const status = disabled ? 'off' : props.error ? 'error' : voiceLabel(props.voiceStatus);
    const title = disabled
        ? 'Jaw CEO is disabled.'
        : props.error
        ? `Jaw CEO error: ${props.error}`
        : `Open Jaw CEO. Single chat session, voice ${voiceLabel(props.voiceStatus)}.`;

    return (
        <div className={`jaw-ceo-workbench-launcher${props.open ? ' is-open' : ''}${active ? ' is-active' : ''}${props.error && !disabled ? ' is-error' : ''}${disabled ? ' is-disabled' : ''}`} aria-label="Jaw CEO launcher">
            <button
                type="button"
                className="jaw-ceo-workbench-button"
                aria-expanded={props.open}
                title={title}
                disabled={disabled}
                onClick={props.onOpenConsole}
            >
                <span className={`jaw-ceo-avatar status-${props.voiceStatus}`} aria-hidden="true">CEO</span>
                <span className="jaw-ceo-workbench-label">CEO</span>
                <span className="jaw-ceo-workbench-status">{status}</span>
            </button>
            <button
                type="button"
                className="jaw-ceo-workbench-icon"
                aria-label={active ? 'Stop Jaw CEO voice' : 'Start Jaw CEO voice'}
                title={active ? 'Stop voice' : 'Start voice'}
                disabled={disabled || props.busy}
                onClick={props.onToggleVoice}
            >
                <MicIcon />
            </button>
        </div>
    );
}
