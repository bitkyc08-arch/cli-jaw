import { useEffect, useMemo, useRef } from 'react';
import type { CodeModelOptions } from './code-session-client';
import type { CodeCommand, CodeCommandPopupKind } from './code-types';

type CodeCommandPopupProps = {
    popupKind: CodeCommandPopupKind;
    command: CodeCommand;
    modelOptions: CodeModelOptions;
    provider: string;
    model: string;
    permissionMode: string;
    disabled?: boolean;
    onClose: () => void;
    onRefreshProviders: () => void;
    onProviderChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onPermissionModeChange: (value: string) => void;
};

function titleForPopup(kind: CodeCommandPopupKind): string {
    if (kind === 'provider') return 'Provider';
    if (kind === 'model') return 'Model';
    if (kind === 'permission') return 'Permissions';
    if (kind === 'session') return 'Session';
    return 'Settings';
}

export function CodeCommandPopup({
    popupKind,
    command,
    modelOptions,
    provider,
    model,
    permissionMode,
    disabled,
    onClose,
    onRefreshProviders,
    onProviderChange,
    onModelChange,
    onPermissionModeChange,
}: CodeCommandPopupProps) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const currentProvider = modelOptions.providers.find(entry => entry.id === provider) ?? modelOptions.providers[0];
    const providerModels = currentProvider?.models ?? [];
    const title = titleForPopup(popupKind);
    const providerCountLabel = useMemo(() => {
        const count = modelOptions.providers.length;
        return `${count} authenticated provider${count === 1 ? '' : 's'}`;
    }, [modelOptions.providers.length]);

    useEffect(() => {
        closeRef.current?.focus();
    }, [popupKind, command.name]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    return (
        <div className="code-popup-backdrop" role="presentation" onMouseDown={event => {
            if (event.target === event.currentTarget) onClose();
        }}>
            <section
                className="code-popup"
                role="dialog"
                aria-modal="true"
                aria-labelledby="code-command-popup-title"
            >
                <header className="code-popup-header">
                    <div>
                        <p className="code-popup-command">{command.displayName}</p>
                        <h2 id="code-command-popup-title">{title}</h2>
                    </div>
                    <button ref={closeRef} type="button" className="code-popup-close" onClick={onClose} aria-label="Close popup">x</button>
                </header>

                {popupKind === 'provider' && (
                    <div className="code-popup-section">
                        <div className="code-popup-section-head">
                            <span>{providerCountLabel}</span>
                            <button type="button" className="code-popup-secondary" disabled={disabled} onClick={onRefreshProviders}>Refresh</button>
                        </div>
                        {modelOptions.degraded && (
                            <p className="code-popup-warning">{modelOptions.error ?? 'Provider discovery is degraded.'}</p>
                        )}
                        <div className="code-provider-list" role="list">
                            {modelOptions.providers.map(entry => (
                                <button
                                    key={entry.id}
                                    type="button"
                                    className={`code-provider-row${entry.id === provider ? ' is-selected' : ''}`}
                                    onClick={() => onProviderChange(entry.id)}
                                    disabled={disabled}
                                >
                                    <span className="code-provider-name">{entry.id}</span>
                                    <span className="code-provider-meta">{entry.models.length} models</span>
                                </button>
                            ))}
                        </div>
                        <div className="code-popup-placeholder-actions">
                            <button type="button" disabled className="code-popup-secondary">Add provider</button>
                            <button type="button" disabled className="code-popup-secondary">Login</button>
                            <span>Provider add/login execution is next slice.</span>
                        </div>
                    </div>
                )}

                {popupKind === 'settings' && (
                    <div className="code-popup-section">
                        <label className="code-popup-field">
                            <span>Permission mode</span>
                            <select value={permissionMode} onChange={event => onPermissionModeChange(event.target.value)} disabled={disabled}>
                                <option value="ask">Ask</option>
                                <option value="auto">Auto</option>
                                <option value="always-allow">Always allow</option>
                                <option value="always-deny">Always deny</option>
                            </select>
                        </label>
                        <div className="code-popup-summary">
                            <span>Provider</span><strong>{provider || '-'}</strong>
                            <span>Model</span><strong>{model || '-'}</strong>
                        </div>
                    </div>
                )}

                {popupKind === 'model' && (
                    <div className="code-popup-section">
                        <label className="code-popup-field">
                            <span>Model</span>
                            <select value={model} onChange={event => onModelChange(event.target.value)} disabled={disabled || providerModels.length === 0}>
                                {providerModels.map(entry => <option key={entry} value={entry}>{entry}</option>)}
                            </select>
                        </label>
                        <p className="code-popup-note">Subagent assignment and default/live model controls are scheduled for the model popup slice.</p>
                    </div>
                )}
            </section>
        </div>
    );
}
