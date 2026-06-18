import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeModelAssignment, CodeModelAssignments, CodeModelOptions, CodeModelPresetInfo } from './code-session-client';
import type { CodeCommand, CodeCommandPopupKind } from './code-types';

type CodeCommandPopupProps = {
    popupKind: CodeCommandPopupKind;
    command: CodeCommand;
    modelOptions: CodeModelOptions;
    provider: string;
    model: string;
    modelAssignments: CodeModelAssignments | null;
    modelPresets: CodeModelPresetInfo | null;
    permissionMode: string;
    disabled?: boolean;
    activeSessionId?: string | null;
    error?: string;
    onClose: () => void;
    onRefreshProviders: () => void;
    onProviderChange: (value: string) => void;
    onUseModel: (provider: string, model: string) => void | Promise<void>;
    onSetDefaultModel: (provider: string, model: string) => void | Promise<void>;
    onSetModelAssignment: (
        role: CodeModelAssignment['role'],
        provider: string,
        model: string,
        thinkingLevel?: string | null,
    ) => void | Promise<void>;
    onClearModelAssignment: (role: CodeModelAssignment['role']) => void | Promise<void>;
    onPermissionModeChange: (value: string) => void;
};

function titleForPopup(kind: CodeCommandPopupKind): string {
    if (kind === 'provider') return 'Provider';
    if (kind === 'model') return 'Model';
    if (kind === 'permission') return 'Permissions';
    if (kind === 'session') return 'Session';
    return 'Settings';
}

function modelSourceLabel(source: string | undefined): string {
    return source === 'jwc-cache' ? 'JWC cache' : 'static fallback';
}

export function CodeCommandPopup({
    popupKind,
    command,
    modelOptions,
    provider,
    model,
    modelAssignments,
    modelPresets,
    permissionMode,
    disabled,
    activeSessionId,
    error,
    onClose,
    onRefreshProviders,
    onProviderChange,
    onUseModel,
    onSetDefaultModel,
    onSetModelAssignment,
    onClearModelAssignment,
    onPermissionModeChange,
}: CodeCommandPopupProps) {
    const closeRef = useRef<HTMLButtonElement>(null);
    const currentProvider = modelOptions.providers.find(entry => entry.id === provider) ?? modelOptions.providers[0];
    const [modelQuery, setModelQuery] = useState('');
    const [draftProvider, setDraftProvider] = useState(provider);
    const [draftModel, setDraftModel] = useState(model);
    const [roleThinkingDrafts, setRoleThinkingDrafts] = useState<Record<string, string>>({});
    const draftProviderRecord = modelOptions.providers.find(entry => entry.id === draftProvider) ?? currentProvider;
    const query = modelQuery.trim().toLowerCase();
    const filteredProviders = useMemo(() => modelOptions.providers.filter(entry => {
        if (!query) return true;
        return entry.id.toLowerCase().includes(query) || entry.models.some(modelId => modelId.toLowerCase().includes(query));
    }), [modelOptions.providers, query]);
    const visibleModels = useMemo(() => {
        const models = draftProviderRecord?.models ?? [];
        if (!query) return models;
        return models.filter(modelId => modelId.toLowerCase().includes(query));
    }, [draftProviderRecord?.models, query]);
    const title = titleForPopup(popupKind);
    const providerCountLabel = useMemo(() => {
        const count = modelOptions.providers.length;
        return `${count} authenticated provider${count === 1 ? '' : 's'}`;
    }, [modelOptions.providers.length]);
    const canUseNow = Boolean(activeSessionId && draftProvider && draftModel && !disabled);
    const canSetDefault = Boolean(draftProvider && draftModel && !disabled);
    const thinkingOptions = useMemo(() => {
        const values = ['inherit', ...(draftProviderRecord?.efforts ?? [])]
            .map(value => value === 'min' ? 'minimal' : value)
            .filter((value, index, list) => value && list.indexOf(value) === index);
        return values.map(value => ({
            value,
            label: value === 'inherit' ? 'inherit' : value === 'minimal' ? 'min' : value,
        }));
    }, [draftProviderRecord?.efforts]);

    useEffect(() => {
        closeRef.current?.focus();
    }, [popupKind, command.name]);

    useEffect(() => {
        if (popupKind !== 'model') return;
        setModelQuery('');
        setDraftProvider(provider);
        setDraftModel(model);
    }, [model, popupKind, provider]);

    useEffect(() => {
        if (popupKind !== 'model') return;
        const models = draftProviderRecord?.models ?? [];
        if (models.length > 0 && !models.includes(draftModel)) {
            setDraftModel(models[0] ?? '');
        }
    }, [draftModel, draftProviderRecord?.models, popupKind]);

    useEffect(() => {
        if (popupKind !== 'model' || !modelAssignments) return;
        const nextDrafts: Record<string, string> = {};
        for (const role of modelAssignments.roles) {
            const thinking = role.thinkingLevel === 'min' ? 'minimal' : role.thinkingLevel;
            nextDrafts[role.role] = thinking || 'inherit';
        }
        setRoleThinkingDrafts(nextDrafts);
    }, [modelAssignments, popupKind]);

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
                        {error && <p className="code-popup-error">{error}</p>}
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
                                    <span className="code-provider-meta">{entry.models.length} models · {modelSourceLabel(entry.modelSource)}</span>
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
                        {error && <p className="code-popup-error">{error}</p>}
                        <label className="code-popup-field">
                            <span>Search models</span>
                            <input
                                type="search"
                                className="code-model-search"
                                placeholder="Search provider or model"
                                value={modelQuery}
                                onChange={event => setModelQuery(event.target.value)}
                                disabled={disabled}
                            />
                        </label>
                        {modelOptions.usageOrder && modelOptions.usageOrder.length > 0 && (
                            <div className="code-model-mru-strip" aria-label="Recently used models">
                                <span>Recently used</span>
                                {modelOptions.usageOrder.slice(0, 3).map(modelKey => (
                                    <strong key={modelKey}>{modelKey}</strong>
                                ))}
                            </div>
                        )}
                        <div className="code-model-layout">
                            <div className="code-model-providers" role="list" aria-label="Providers">
                                {filteredProviders.map(entry => (
                                    <button
                                        key={entry.id}
                                        type="button"
                                        className={`code-model-provider${entry.id === draftProvider ? ' is-selected' : ''}`}
                                        onClick={() => {
                                            setDraftProvider(entry.id);
                                            setDraftModel(entry.models[0] ?? '');
                                        }}
                                        disabled={disabled}
                                    >
                                        <span>{entry.id}</span>
                                        <small>{entry.models.length}</small>
                                    </button>
                                ))}
                            </div>
                            <div className="code-model-list" role="list" aria-label="Models">
                                <div className="code-model-list-head">
                                    <strong>{draftProviderRecord?.id ?? 'No provider'}</strong>
                                    <span>{visibleModels.length} models · {modelSourceLabel(draftProviderRecord?.modelSource)}</span>
                                </div>
                                {visibleModels.length === 0 ? (
                                    <p className="code-popup-note">No models match this search.</p>
                                ) : visibleModels.map(entry => {
                                    const isActive = draftProvider === provider && entry === model;
                                    const isDraft = entry === draftModel;
                                    return (
                                        <button
                                            key={entry}
                                            type="button"
                                            className={`code-model-row${isActive ? ' is-active' : ''}${isDraft ? ' is-draft' : ''}`}
                                            onClick={() => setDraftModel(entry)}
                                            disabled={disabled}
                                        >
                                            <span>{entry}</span>
                                            <small>{isActive ? 'Active' : isDraft ? 'Selected' : 'Available'}</small>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="code-popup-action-row">
                            <div className="code-popup-summary code-popup-summary-compact">
                                <span>Active</span><strong>{provider || '-'} / {model || '-'}</strong>
                                <span>Selected</span><strong>{draftProvider || '-'} / {draftModel || '-'}</strong>
                                <span>Default</span><strong>{modelOptions.defaultProvider || '-'} / {modelOptions.defaultModel || '-'}</strong>
                            </div>
                            <div className="code-popup-action-stack">
                                <button
                                    type="button"
                                    className="code-popup-primary"
                                    disabled={!canUseNow}
                                    onClick={() => {
                                        void onUseModel(draftProvider, draftModel);
                                    }}
                                >
                                    Use now
                                </button>
                                <button
                                    type="button"
                                    className="code-popup-secondary"
                                    disabled={!canSetDefault}
                                    onClick={() => {
                                        void onSetDefaultModel(draftProvider, draftModel);
                                    }}
                                >
                                    Set default
                                </button>
                            </div>
                        </div>
                        {!activeSessionId && <p className="code-popup-note">Start or load a Code session to apply a live model.</p>}
                        <div className="code-role-assignment-panel" aria-label="Model role assignments">
                            <div className="code-role-assignment-head">
                                <strong>Role assignments</strong>
                                <span>{modelAssignments?.activeModel.note ?? 'Role assignments do not mutate the active Code session model.'}</span>
                            </div>
                            <div className="code-role-assignment-grid" role="list">
                                {(modelAssignments?.roles ?? []).map(role => {
                                    const assigned = role.modelId ? role.modelId : 'Unset';
                                    const roleThinking = roleThinkingDrafts[role.role] ?? (role.thinkingLevel === 'min' ? 'minimal' : role.thinkingLevel) ?? 'inherit';
                                    const canAssign = Boolean(draftProvider && draftModel && !disabled);
                                    const canClear = Boolean(role.modelId && !disabled);
                                    return (
                                        <article className="code-role-card" key={role.role} role="listitem">
                                            <div className="code-role-card-head">
                                                <span className="code-role-tag">{role.tag}</span>
                                                <strong>{role.name}</strong>
                                            </div>
                                            <p className="code-role-path">{role.settingsPath}</p>
                                            <p className="code-role-model" title={assigned}>{assigned}</p>
                                            <label className="code-role-thinking">
                                                <span>Thinking</span>
                                                <select
                                                    value={roleThinking}
                                                    disabled={disabled}
                                                    onChange={event => {
                                                        const value = event.target.value;
                                                        setRoleThinkingDrafts(prev => ({ ...prev, [role.role]: value }));
                                                    }}
                                                >
                                                    {thinkingOptions.map(option => (
                                                        <option key={option.value} value={option.value}>{option.label}</option>
                                                    ))}
                                                </select>
                                            </label>
                                            <div className="code-role-actions">
                                                <button
                                                    type="button"
                                                    className="code-popup-secondary"
                                                    disabled={!canAssign}
                                                    onClick={() => {
                                                        void onSetModelAssignment(
                                                            role.role,
                                                            draftProvider,
                                                            draftModel,
                                                            roleThinking === 'inherit' ? null : roleThinking,
                                                        );
                                                    }}
                                                >
                                                    Assign selected
                                                </button>
                                                <button
                                                    type="button"
                                                    className="code-popup-secondary"
                                                    disabled={!canClear}
                                                    onClick={() => {
                                                        void onClearModelAssignment(role.role);
                                                    }}
                                                >
                                                    Clear
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                            {!modelAssignments && <p className="code-popup-note">Loading role assignments.</p>}
                        </div>
                        <div className="code-model-preset-panel" aria-label="Model profiles and presets">
                            <div className="code-role-assignment-head">
                                <strong>Profiles and presets</strong>
                                <span>{modelPresets?.applyReason ?? 'Loading JWC profile state.'}</span>
                            </div>
                            <div className="code-model-preset-summary">
                                <span>Startup profile</span>
                                <strong>{modelPresets?.defaultProfile ?? 'Unset'}</strong>
                                <span>Task presets</span>
                                <strong>{modelPresets ? modelPresets.taskPresets.length : '-'}</strong>
                                <span>Built-in profiles</span>
                                <strong>{modelPresets ? modelPresets.builtinProfiles.length : '-'}</strong>
                            </div>
                            {modelPresets && modelPresets.taskPresets.length > 0 && (
                                <div className="code-model-preset-list" role="list" aria-label="Task model presets">
                                    {modelPresets.taskPresets.slice(0, 4).map(preset => (
                                        <div className="code-model-preset-row" role="listitem" key={preset.name}>
                                            <strong>{preset.name}</strong>
                                            <span>{preset.best ? `best ${preset.best}` : 'best unset'}</span>
                                            <span>{preset.cheap ? `cheap ${preset.cheap}` : 'cheap unset'}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {modelPresets && (
                                <div className="code-model-profile-chips" aria-label="Built-in profile candidates">
                                    {modelPresets.builtinProfiles.slice(0, 8).map(profile => (
                                        <span key={profile.name}>{profile.name}</span>
                                    ))}
                                </div>
                            )}
                            <div className="code-popup-placeholder-actions">
                                <button type="button" disabled className="code-popup-secondary">Apply profile</button>
                                <span>Profile activation is read-only here; JWC runtime owns credential checks and rollback.</span>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}
