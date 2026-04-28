import type { MouseEvent } from 'react';
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
    onSelect: (instance: DashboardInstance) => void;
    onPreview: (instance: DashboardInstance) => void;
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

function instanceSecondaryLine(instance: DashboardInstance, label: string, profile?: DashboardProfile): string {
    if (profile) {
        return [
            label !== profile.label ? label : null,
            instance.workingDir || instance.url,
        ].filter(Boolean).join(' · ');
    }

    if (instance.group) {
        return `${instance.group} · ${instance.workingDir || instance.url}`;
    }

    return instance.workingDir || instance.url;
}

export function InstanceRow(props: InstanceRowProps) {
    const lifecycle = props.instance.lifecycle;
    const reason = lifecycle?.reason || props.instance.healthReason || 'ok';

    function stopAction(event: MouseEvent<HTMLElement>): void {
        event.stopPropagation();
    }

    const transitionLabel = props.transitioning ? TRANSITION_LABELS[props.transitioning] : null;
    const dotClass = `${statusClass(props.instance.status)}${transitionLabel ? ' is-transitioning' : ''}`;
    const primaryLabel = props.profile?.label || props.label;
    const secondaryLine = transitionLabel
        ? null
        : instanceSecondaryLine(props.instance, props.label, props.profile);

    return (
        <article className={`instance-row density-${props.density || 'comfortable'} priority-${props.priority || 'normal'} ${props.selected ? 'is-selected' : ''}${transitionLabel ? ' is-transitioning-row' : ''}`}>
            <button
                className="instance-row-select"
                type="button"
                aria-pressed={props.selected}
                onClick={() => props.onSelect(props.instance)}
            >
                <div className="instance-row-main">
                    <span className={dotClass} aria-label={props.instance.status} />
                    <div className="instance-row-title">
                        <strong>{props.instance.favorite ? `Pinned ${primaryLabel}` : primaryLabel}</strong>
                        <span>
                            {transitionLabel
                                ? <em className="instance-row-transition">{transitionLabel}</em>
                                : secondaryLine}
                        </span>
                    </div>
                    <span className="port">:{props.instance.port}</span>
                </div>
                <div className="instance-row-meta">
                    <span className="instance-row-runtime">{props.instance.currentCli || 'cli n/a'} / {props.instance.currentModel || 'model n/a'}</span>
                    <span className="instance-row-version">v{props.instance.version || 'n/a'} · {props.uptime}</span>
                    <span className="instance-row-reason">{new Date(props.instance.lastCheckedAt).toLocaleTimeString()} · {reason}</span>
                </div>
            </button>
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
