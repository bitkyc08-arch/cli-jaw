import { ChevronDown, Mic, Plus, Send, Shield, Square } from '@lucide/icons';
import type { JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import type { VoiceState } from './useVoiceRecorder.ts';

export interface ComposerPickerDisplay {
    provider?: string;
    model?: string;
    effort?: string;
    readOnly?: boolean;
}

interface ComposerFooterProps {
    picker?: ComposerPickerDisplay;
    goalLabel?: string | null;
    disabled?: boolean;
    canSend: boolean;
    isRunning?: boolean;
    voiceState: VoiceState;
    onAttach(): void;
    onVoice(): void;
    onSend(): void;
    onStop?(): void;
}

export function ComposerFooter(props: ComposerFooterProps): JSX.Element {
    const pickerLabel = [props.picker?.provider, props.picker?.model, props.picker?.effort]
        .filter(Boolean).join(' · ') || 'Instance defaults';
    const recording = props.voiceState === 'recording';
    const voiceBusy = props.voiceState === 'requesting' || props.voiceState === 'transcribing';
    return (
        <div className="d2-composer-footer">
            <div className="d2-composer-controls d2-composer-controls-left">
                <button type="button" className="d2-composer-icon" aria-label="Attach files" title="Attach files" onClick={props.onAttach} disabled={props.disabled}>
                    <Icon icon={Plus} />
                </button>
                <button type="button" className="d2-composer-access" aria-label="Full access" title="Permission mode is managed by the instance" disabled>
                    <Icon icon={Shield} /><span>Full access</span>
                </button>
                {props.goalLabel ? <span className="d2-composer-goal">{props.goalLabel}</span> : null}
            </div>
            <div className="d2-composer-controls d2-composer-controls-right">
                <button
                    type="button"
                    className="d2-composer-picker"
                    aria-label={`Provider and model: ${pickerLabel}`}
                    title={props.picker?.readOnly !== false ? 'Instance settings are read-only here' : pickerLabel}
                    disabled={props.picker?.readOnly !== false}
                >
                    <span>{pickerLabel}</span><Icon icon={ChevronDown} size={14} />
                </button>
                <button type="button" className={recording ? 'd2-composer-icon is-recording' : 'd2-composer-icon'} aria-label={recording ? 'Stop recording' : 'Start voice input'} title="Voice input" onClick={props.onVoice} disabled={props.disabled || voiceBusy}>
                    <Icon icon={recording ? Square : Mic} />
                </button>
                {props.isRunning ? (
                    <button type="button" className="d2-composer-icon d2-composer-primary" aria-label="Stop response" title="Stop response" onClick={props.onStop} disabled={!props.onStop}>
                        <Icon icon={Square} />
                    </button>
                ) : (
                    <button type="button" className="d2-composer-icon d2-composer-primary" aria-label="Send message" title="Send message" onClick={props.onSend} disabled={props.disabled || !props.canSend}>
                        <Icon icon={Send} />
                    </button>
                )}
            </div>
        </div>
    );
}
