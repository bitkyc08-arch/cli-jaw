// Per-CLI model, effort, runtime transport, and fast mode defaults.

import { useState } from 'react';
import { TextField, SelectField, ToggleField } from '../../fields';
import type { SettingsClient } from '../../types';
import type { DirtyEntry } from '../../types';
import { coerceEffortForModel, effortChoicesForModel } from './agent/agent-meta';
import type { CliMeta, PerCliEntry } from './agent/agent-meta';
import { PiProfileDialog } from './PiProfileDialog';
import { piModelOptions, piProfileOptions, type PiSettingsView } from './pi-profile';
import { canSelectRuntimeTransport, transportFieldValue, transportFieldPatch } from './runtime-transport-field';

type Props = {
    cli: string;
    meta: CliMeta;
    original: PerCliEntry;
    value: PerCliEntry;
    setValue: (next: PerCliEntry) => void;
    setEntry: (key: string, entry: DirtyEntry) => void;
    client?: SettingsClient;
    pi?: PiSettingsView | undefined;
    setPi?: (next: PiSettingsView) => void;
};

function entryFor(value: unknown, original: unknown, valid = true): DirtyEntry {
    return { value, original, valid };
}

export function PerCliRow({ cli, meta, original, value, setValue, setEntry, client, pi, setPi }: Props) {
    const modelDatalistId = `percli-${cli}-models`;
    const isPi = cli === 'pi';
    const [piDialogOpen, setPiDialogOpen] = useState(false);
    const provider = value.provider || meta.defaultProvider || meta.providers?.[0] || 'claude';
    const piModels = isPi ? piModelOptions(pi, provider, value.model || '') : [];
    const hasProviders = !isPi && (meta.providers?.length ?? 0) > 0;
    const modelOptions = isPi
        ? piModels
        : hasProviders
        ? (meta.modelsByProvider?.[provider] ?? meta.models)
        : meta.models;
    const providerEfforts = hasProviders ? (meta.effortsByProvider?.[provider] ?? meta.efforts) : undefined;
    // Per-model effort sets from a live opencodex catalog win over the
    // provider/registry lists; the chosen value is forwarded to the wire.
    const effortOptions = effortChoicesForModel(meta, value.model || '', providerEfforts, hasProviders ? provider : undefined);

    return (
        <div className="settings-percli-row" data-cli={cli}>
            <h3 className="settings-percli-title">{meta.label}</h3>
            <div className="settings-percli-grid">
                {isPi && piProfileOptions(pi, provider).length ? (
                    <SelectField
                        id={`percli-${cli}-provider`}
                        label="Provider"
                        value={provider}
                        options={piProfileOptions(pi, provider).map((p) => ({ value: p, label: p }))}
                        onChange={(next) => {
                            const nextModels = piModelOptions(pi, next);
                            const nextModel = nextModels.includes(value.model || '') ? (value.model || '') : (nextModels[0] || '');
                            setValue({ ...value, provider: next, model: nextModel });
                            setEntry(`perCli.${cli}.provider`, entryFor(next, original.provider ?? 'progrok'));
                            setEntry(`perCli.${cli}.model`, entryFor(nextModel, original.model ?? ''));
                        }}
                    />
                ) : hasProviders ? (
                    <SelectField
                        id={`percli-${cli}-provider`}
                        label="Provider"
                        value={provider}
                        options={(meta.providers ?? []).map((p) => ({ value: p, label: p }))}
                        onChange={(next) => {
                            const nextModels = meta.modelsByProvider?.[next] ?? [];
                            const nextEfforts = meta.effortsByProvider?.[next] ?? [];
                            const nextModel = nextModels.includes(value.model || '') ? (value.model || '') : (nextModels[0] || '');
                            // Resolve against the NEW provider+model pair: the same
                            // model id can allow different efforts per provider.
                            const nextEffort = coerceEffortForModel(meta, nextModel, value.effort ?? '', nextEfforts, next);
                            setValue({ ...value, provider: next, model: nextModel, effort: nextEffort });
                            setEntry(`perCli.${cli}.provider`, entryFor(next, original.provider ?? meta.defaultProvider ?? 'claude'));
                            setEntry(`perCli.${cli}.model`, entryFor(nextModel, original.model ?? ''));
                            setEntry(`perCli.${cli}.effort`, entryFor(nextEffort, original.effort ?? ''));
                        }}
                    />
                ) : null}
                <div className="settings-percli-model">
                    {isPi && modelOptions.length > 0 ? (
                        <SelectField
                            id={`percli-${cli}-model`}
                            label="Model"
                            value={value.model ?? modelOptions[0] ?? ''}
                            options={modelOptions.map((m) => ({ value: m, label: m }))}
                            onChange={(next) => {
                                const nextEffort = coerceEffortForModel(meta, next, value.effort ?? '', providerEfforts, hasProviders ? provider : undefined);
                                setValue({ ...value, model: next, effort: nextEffort });
                                setEntry(`perCli.${cli}.model`, entryFor(next, original.model ?? ''));
                                if (nextEffort !== (value.effort ?? '')) {
                                    setEntry(`perCli.${cli}.effort`, entryFor(nextEffort, original.effort ?? ''));
                                }
                            }}
                        />
                    ) : (
                        <TextField
                            id={`percli-${cli}-model`}
                            label="Model"
                            value={value.model ?? ''}
                            onChange={(next) => {
                                setValue({ ...value, model: next });
                                setEntry(`perCli.${cli}.model`, entryFor(next, original.model ?? ''));
                            }}
                            placeholder={modelOptions[0] ?? 'model id'}
                        />
                    )}
                    {meta.modelNote ? (
                        <p className="settings-percli-note">{meta.modelNote}</p>
                    ) : null}
                    {modelOptions.length > 0 ? (
                        <datalist id={modelDatalistId}>
                            {modelOptions.map((m) => (
                                <option key={m} value={m} />
                            ))}
                        </datalist>
                    ) : null}
                </div>
                {effortOptions.length > 0 ? (
                    <div className="settings-percli-effort">
                        <SelectField
                            id={`percli-${cli}-effort`}
                            label="Effort"
                            value={value.effort ?? ''}
                            options={[
                                { value: '', label: '(default)' },
                                ...effortOptions.map((e) => ({ value: e, label: e })),
                            ]}
                            onChange={(next) => {
                                setValue({ ...value, effort: next });
                                setEntry(`perCli.${cli}.effort`, entryFor(next, original.effort ?? ''));
                            }}
                        />
                        {meta.effortNote ? (
                            <p className="settings-percli-note">{meta.effortNote}</p>
                        ) : null}
                    </div>
                ) : meta.effortNote ? (
                    <p className="settings-percli-note settings-percli-note--effort">{meta.effortNote}</p>
                ) : null}
                {canSelectRuntimeTransport(cli) ? (
                    <SelectField
                        id={`percli-${cli}-transport`}
                        label="Runtime transport"
                        value={transportFieldValue(value.transport)}
                        options={[
                            { value: 'native', label: 'Native session' },
                            { value: 'print', label: 'Print compatibility' },
                        ]}
                        onChange={(next) => {
                            const patch = transportFieldPatch(cli, next);
                            if (next !== 'native' && next !== 'print') return;
                            setValue({ ...value, transport: next });
                            setEntry(`perCli.${cli}.transport`, entryFor(
                                patch[`perCli.${cli}.transport`], transportFieldValue(original.transport),
                            ));
                        }}
                    />
                ) : null}
                <ToggleField
                    id={`percli-${cli}-fastmode`}
                    label="Fast mode"
                    value={Boolean(value.fastMode)}
                    onChange={(next) => {
                        setValue({ ...value, fastMode: next });
                        setEntry(`perCli.${cli}.fastMode`, entryFor(next, Boolean(original.fastMode)));
                    }}
                />
                {isPi && client ? (
                    <button
                        type="button"
                        className="settings-action"
                        onClick={() => setPiDialogOpen(true)}
                    >
                        Settings
                    </button>
                ) : null}
            </div>
            {isPi && client && piDialogOpen ? (
                <PiProfileDialog
                    client={client}
                    pi={pi}
                    provider={provider}
                    model={value.model || 'grok-composer-2.5-fast'}
                    onClose={() => setPiDialogOpen(false)}
                    onRegistered={({ provider: nextProvider, model: nextModel, pi: nextPi }) => {
                        if (nextPi && setPi) setPi(nextPi);
                        setValue({ ...value, provider: nextProvider, model: nextModel });
                        setEntry(`perCli.${cli}.provider`, entryFor(nextProvider, original.provider ?? 'progrok'));
                        setEntry(`perCli.${cli}.model`, entryFor(nextModel, original.model ?? ''));
                    }}
                />
            ) : null}
        </div>
    );
}
