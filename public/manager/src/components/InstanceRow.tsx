import { useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import type { DashboardInstance, DashboardLifecycleAction, DashboardProfile } from '../types';

type InstanceRowProps = {
    instance: DashboardInstance;
    profile?: DashboardProfile;
    selected: boolean;
    busy: boolean;
    label: string;
    uptime: string;
    density?: 'compact' | 'comfortable' | 'rail';
    priority?: 'active' | 'pinned' | 'normal' | 'hidden';
    transitioning?: DashboardLifecycleAction | null;
    activityUnreadCount?: number;
    latestActivityTitle?: string | null;
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
    onMarkActivitySeen: (port: number) => void;
    onInstanceLabelSave: (port: number, label: string | null) => Promise<void>;
    onLifecycle: (action: DashboardLifecycleAction, instance: DashboardInstance) => void;
};

const TRANSITION_LABELS: Record<DashboardLifecycleAction, string> = {
    start: 'starting…',
    stop: 'stopping…',
    restart: 'restarting…',
};

function statusClass(status: DashboardInstance['status']): string {
    return `instance-status status-${status}`;
}

export function InstanceRow(props: InstanceRowProps) {
    const lifecycle = props.instance.lifecycle;
    const reason = lifecycle?.reason || props.instance.healthReason || 'ok';
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(props.instance.label || props.profile?.label || props.label);
    const [savingLabel, setSavingLabel] = useState(false);
    const [labelError, setLabelError] = useState<string | null>(null);

    function stopAction(event: MouseEvent<HTMLElement>): void {
        event.stopPropagation();
    }

    const transitionLabel = props.transitioning ? TRANSITION_LABELS[props.transitioning] : null;
    const dotClass = `${statusClass(props.instance.status)}${transitionLabel ? ' is-transitioning' : ''}`;
    const primaryLabel = props.instance.label || props.profile?.label || props.label;

    async function submitLabel(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        event.stopPropagation();
        setSavingLabel(true);
        setLabelError(null);
        try {
            await props.onInstanceLabelSave(props.instance.port, draft);
            setEditing(false);
        } catch (error) {
            setLabelError((error as Error).message);
        } finally {
            setSavingLabel(false);
        }
    }

    return (
        <article className={`instance-row density-${props.density || 'comfortable'} priority-${props.priority || 'normal'} ${props.selected ? 'is-selected' : ''}${transitionLabel ? ' is-transitioning-row' : ''}`}>
            <button
                className="instance-row-select"
                type="button"
                aria-pressed={props.selected}
                onClick={() => {
                    props.onSelect(props.instance);
                }}
            >
                <div className="instance-row-main">
                    <span className={dotClass} aria-label={props.instance.status} />
                    <div className="instance-row-title">
                        <div className="instance-row-title-line">
                            <strong>{props.instance.favorite ? `Pinned ${primaryLabel}` : primaryLabel}</strong>
                            {props.activityUnreadCount ? (
                                <span className="instance-unread-badge" aria-label={`${props.activityUnreadCount} unread activity`}>
                                    ({props.activityUnreadCount > 99 ? '99+' : props.activityUnreadCount})
                                </span>
                            ) : null}
                        </div>
                        {transitionLabel && <span><em className="instance-row-transition">{transitionLabel}</em></span>}
                    </div>
                    <span className="port">:{props.instance.port}</span>
                </div>
                <div className="instance-row-meta">
                    {props.latestActivityTitle && <span className="instance-row-activity-title">{props.latestActivityTitle}</span>}
                    <span className="instance-row-runtime">{props.instance.currentCli || 'cli n/a'} / {props.instance.currentModel || 'model n/a'}</span>
                    <span className="instance-row-version">v{props.instance.version || 'n/a'} · {props.uptime}</span>
                    <span className="instance-row-reason">{new Date(props.instance.lastCheckedAt).toLocaleTimeString()} · {reason}</span>
                </div>
            </button>
            {editing ? (
                <form className="instance-label-edit-form" onSubmit={(event) => void submitLabel(event)} onClick={stopAction}>
                    <input
                        className="instance-label-input"
                        value={draft}
                        maxLength={120}
                        aria-label={`Rename ${primaryLabel}`}
                        onChange={event => setDraft(event.target.value)}
                    />
                    <button className="instance-label-save" type="submit" disabled={savingLabel}>Save</button>
                    <button
                        className="instance-label-cancel"
                        type="button"
                        disabled={savingLabel}
                        onClick={() => {
                            setDraft(props.instance.label || props.profile?.label || props.label);
                            setLabelError(null);
                            setEditing(false);
                        }}
                    >
                        Cancel
                    </button>
                    {labelError && <span className="instance-label-error">{labelError}</span>}
                </form>
            ) : (
                <button
                    className="instance-label-edit-button"
                    type="button"
                    aria-label={`Rename ${primaryLabel}`}
                    title="Rename"
                    onClick={(event) => {
                        stopAction(event);
                        setDraft(props.instance.label || props.profile?.label || props.label);
                        setLabelError(null);
                        setEditing(true);
                    }}
                >
                    <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                </button>
            )}
            <div className="instance-actions">
                <button
                    type="button"
                    onClick={(event) => {
                        stopAction(event);
                        props.onPreview(props.instance);
                    }}
                    disabled={!props.instance.ok}
                >
                    Preview
                </button>
                <a
                    className="open-link"
                    href={props.instance.ok ? props.instance.url : undefined}
                    target={props.instance.ok ? '_blank' : undefined}
                    rel={props.instance.ok ? 'noreferrer' : undefined}
                    aria-disabled={!props.instance.ok || undefined}
                    tabIndex={props.instance.ok ? undefined : -1}
                    onClick={(event) => {
                        if (!props.instance.ok) {
                            event.preventDefault();
                            event.stopPropagation();
                            return;
                        }
                        stopAction(event);
                        props.onMarkActivitySeen(props.instance.port);
                    }}
                >
                    Open
                </a>
                <button
                    type="button"
                    onClick={(event) => {
                        stopAction(event);
                        props.onLifecycle('start', props.instance);
                    }}
                    disabled={!lifecycle?.canStart || props.busy}
                    title={lifecycle?.commandPreview.join(' ')}
                >
                    Start
                </button>
                <button
                    type="button"
                    onClick={(event) => {
                        stopAction(event);
                        props.onLifecycle('stop', props.instance);
                    }}
                    disabled={!lifecycle?.canStop || props.busy}
                >
                    Stop
                </button>
                <button
                    type="button"
                    onClick={(event) => {
                        stopAction(event);
                        props.onLifecycle('restart', props.instance);
                    }}
                    disabled={!lifecycle?.canRestart || props.busy}
                >
                    Restart
                </button>
            </div>
        </article>
    );
}
