import { ChevronDown, Mic, Plus, Send, Shield, Square } from '@lucide/icons';
import type { JSX } from 'react';
import { Icon } from '../../shell/Icon.tsx';
import { ModelPicker, type ModelPickerProps } from '../../models/ModelPicker.tsx';
import type { VoiceState } from './useVoiceRecorder.ts';

export type ComposerPickerDisplay = Omit<ModelPickerProps, 'compact'>;

interface ComposerFooterProps {
    picker?: ComposerPickerDisplay;
    goalLabel?: string | null;
    phase?: string | null;
    disabled?: boolean;
    canSend: boolean;
    isRunning?: boolean;
    voiceState: VoiceState;
    onAttach(): void;
    onVoice(): void;
    onSend(): void;
    onStop?(): void;
}

const PHASE_COLORS: Record<string, string> = {
    I: '#c084fc',  // violet-400 — interview/discovery
    P: '#7aa2f7',  // blue — plan
    A: '#fbbf24',  // amber-400 — audit
    B: '#4ade80',  // green-400 — build
    C: '#fb923c',  // orange-400 — check/verify
    D: '#22d3ee',  // cyan-400 — deliver
};

export function ComposerFooter(props: ComposerFooterProps): JSX.Element {
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
                {props.phase && props.phase !== 'IDLE' ? (
                    <span
                        className="d2-composer-phase"
                        style={{ '--phase-color': PHASE_COLORS[props.phase] ?? 'var(--d2-muted)' } as React.CSSProperties}
                    >
                        {props.goalLabel ? `goal \u00b7 ${props.phase}` : props.phase}
                    </span>
                ) : null}
            </div>
            <div className="d2-composer-controls d2-composer-controls-right">
                {props.picker ? <ModelPicker {...props.picker} compact /> : (
                    <button type="button" className="d2-composer-picker" disabled aria-label="Provider and model unavailable">
                        <span>Instance defaults</span><Icon icon={ChevronDown} size={14} />
                    </button>
                )}
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
