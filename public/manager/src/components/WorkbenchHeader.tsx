import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { instanceLabel } from '../instance-label';
import { icon } from '../../../js/icons';
import { HelpTopicButton } from '../help/HelpTopicButton';
import type { HelpTopicId } from '../help/helpContent';
import type { DashboardInstance } from '../types';

type WorkbenchHeaderProps = {
    instance: DashboardInstance | null;
    previewEnabled: boolean;
    onPreviewEnabledChange: (enabled: boolean) => void;
    onPreviewRefresh: () => void;
    onOpenHelpTopic?: (topic: HelpTopicId) => void;
    /** #233 follow-up: open the native folder chooser for this instance. */
    onPickProject?: (port: number) => void;
    projectPickBusy?: boolean;
};

function compactPath(path: string): string {
    const parts = path.split(/[/\\]/).filter(Boolean);
    if (parts.length <= 2) return path;
    return `…/${parts.slice(-2).join('/')}`;
}

export function WorkbenchHeader(props: WorkbenchHeaderProps) {
    const instance = props.instance;
    const canPreview = Boolean(instance?.ok);
    const previewLabel = props.previewEnabled ? 'Preview on' : 'Preview off';
    const hasActions = Boolean(instance || props.onOpenHelpTopic);
    const projectDirs = instance?.projectDirs?.filter(Boolean) ?? [];

    return (
        <div className="detail-header">
            <div>
                <p className="eyebrow">Selected instance</p>
                <h2>{instance ? instanceLabel(instance) : 'No instance selected'}</h2>
                {instance ? (
                    <div className={`project-dirs${projectDirs.length ? '' : ' is-empty'}`}>
                        <span className="label">Project</span>
                        {projectDirs.length ? projectDirs.map((dir, i) => (
                            <span key={i} className="project-dir" title={dir}>
                                {compactPath(dir)}
                            </span>
                        )) : (
                            <span className="project-dir">Not set</span>
                        )}
                        {props.onPickProject && instance.ok ? (
                            <button
                                type="button"
                                className="project-pick-button"
                                disabled={props.projectPickBusy}
                                title="Open the folder chooser on this machine and set the project root"
                                onClick={() => props.onPickProject?.(instance.port)}
                            >
                                {props.projectPickBusy ? 'Choosing…' : projectDirs.length ? 'Change' : 'Choose…'}
                            </button>
                        ) : null}
                    </div>
                ) : (
                    <span>Select an online instance to inspect it.</span>
                )}
            </div>
            {hasActions && (
                <div className="detail-header-actions">
                    {props.onOpenHelpTopic ? (
                        <HelpTopicButton topic="instances" label="Open Instances help" onOpen={props.onOpenHelpTopic} />
                    ) : null}
                    {instance ? (
                        <>
                            <span
                                className={`preview-inline-status ${instance.ok && props.previewEnabled ? 'is-ready' : 'is-unavailable'}`}
                                aria-label={instance.ok && props.previewEnabled ? 'Preview ready' : 'Preview unavailable'}
                                title={instance.ok && props.previewEnabled ? 'Preview ready' : 'Preview unavailable'}
                            />
                            <button
                                type="button"
                                className={`preview-switch ${props.previewEnabled ? 'is-on' : 'is-off'}`}
                                role="switch"
                                aria-checked={props.previewEnabled}
                                disabled={!canPreview}
                                onClick={() => props.onPreviewEnabledChange(!props.previewEnabled)}
                            >
                                <span className="preview-switch-track" aria-hidden="true" />
                                <span>{previewLabel}</span>
                            </button>
                            <button
                                type="button"
                                className="preview-refresh-button"
                                disabled={!canPreview || !props.previewEnabled}
                                onClick={props.onPreviewRefresh}
                            >
                                Refresh
                            </button>
                            <a className="open-link" href={instance.url} target="_blank" rel="noreferrer">
                                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                </svg>
                                Open
                            </a>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
}

export function WorkbenchSettingsToggle(props: { open: boolean; onToggle: () => void }) {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    useEffect(() => { setSlot(document.getElementById('command-settings-slot')); }, []);
    if (!slot) return null;
    return createPortal(<button type="button" className="workbench-settings-toggle" aria-label="Instance settings"
        title="Instance settings" aria-pressed={props.open} aria-controls="workbench-instance-settings"
        onClick={props.onToggle}>
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('settings', 16) }} />
    </button>, slot);
}
