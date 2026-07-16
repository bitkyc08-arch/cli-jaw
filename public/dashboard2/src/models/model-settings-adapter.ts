import type { SettingsRecord } from '../features/settings/settings-types.ts';

export type ModelMutationMode = 'active' | 'default';

export interface ModelSelection {
    cli: string;
    provider: string;
    model: string;
    effort: string;
}

export interface ModelOption {
    value: string;
    label: string;
    synthetic: boolean;
}

export type ModelCatalogOption = ModelOption;

export interface ModelCatalog {
    cli: string;
    cliOptions: ModelOption[];
    providerOptions: ModelOption[];
    modelOptions: ModelOption[];
    effortOptions: ModelOption[];
    modelsByProvider: Record<string, ModelOption[]>;
    effortsByProvider: Record<string, ModelOption[]>;
    registryDefaultProvider: string;
    registryDefaultModel: string;
    registryDefaultEffort: string;
    providerMutable: boolean;
    mutationEnabled: boolean;
    mutationDisabledReason: string | null;
}

export interface AdaptedModelSettings {
    selection: ModelSelection;
    defaultSelection: ModelSelection;
    catalog: ModelCatalog;
    hasActiveOverride: boolean;
    activeOverrideMasksDefault: boolean;
}

interface RegistryEntry {
    defaultProvider: string;
    defaultModel: string;
    defaultEffort: string;
    providers: string[];
    models: string[];
    efforts: string[];
    modelsByProvider: Record<string, string[]>;
    effortsByProvider: Record<string, string[]>;
}

function isRecord(value: unknown): value is SettingsRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ownString(record: SettingsRecord, key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(record, key) && typeof record[key] === 'string'
        ? record[key] as string
        : undefined;
}

function recordAt(record: SettingsRecord, key: string): SettingsRecord {
    return isRecord(record[key]) ? record[key] : {};
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function stringArrayRecord(value: unknown): Record<string, string[]> {
    if (!isRecord(value)) return {};
    const result: Record<string, string[]> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!Array.isArray(item)) continue;
        result[key] = stringArray(item);
    }
    return result;
}

function isRegistryEntry(value: unknown): value is SettingsRecord {
    if (!isRecord(value)) return false;
    return typeof value['defaultModel'] === 'string'
        || Array.isArray(value['models'])
        || Array.isArray(value['efforts'])
        || Array.isArray(value['providers'])
        || isRecord(value['modelsByProvider'])
        || isRecord(value['effortsByProvider']);
}

function decodeRegistryEntry(value: unknown): RegistryEntry | null {
    if (!isRegistryEntry(value)) return null;
    return {
        defaultProvider: ownString(value, 'defaultProvider') ?? '',
        defaultModel: ownString(value, 'defaultModel') ?? '',
        defaultEffort: ownString(value, 'defaultEffort') ?? '',
        providers: stringArray(value['providers']),
        models: stringArray(value['models']),
        efforts: stringArray(value['efforts']),
        modelsByProvider: stringArrayRecord(value['modelsByProvider']),
        effortsByProvider: stringArrayRecord(value['effortsByProvider']),
    };
}

function option(value: string, synthetic = false): ModelOption {
    return { value, label: value || 'Default / none', synthetic };
}

function options(values: readonly string[], current?: string, includeEmpty = false): ModelOption[] {
    const result: ModelOption[] = [];
    const seen = new Set<string>();
    const add = (value: string, synthetic: boolean): void => {
        if (seen.has(value)) return;
        seen.add(value);
        result.push(option(value, synthetic));
    };
    if (includeEmpty) add('', false);
    for (const value of values) add(value, false);
    if (current !== undefined && !seen.has(current)) add(current, true);
    return result;
}

function registryEntries(registry: SettingsRecord): Record<string, RegistryEntry> {
    const result: Record<string, RegistryEntry> = {};
    for (const [cli, value] of Object.entries(registry)) {
        const entry = decodeRegistryEntry(value);
        if (entry) result[cli] = entry;
    }
    return result;
}

function inferProvider(entry: RegistryEntry, model: string): string {
    if (model) {
        const match = Object.entries(entry.modelsByProvider)
            .find(([, models]) => models.includes(model));
        if (match) return match[0];
    }
    return entry.defaultProvider || entry.providers[0] || Object.keys(entry.modelsByProvider)[0] || '';
}

function effectiveProvider(
    cli: string,
    perCli: SettingsRecord,
    activeOverride: SettingsRecord,
    entry: RegistryEntry,
    model: string,
): string {
    const configured = ownString(perCli, 'provider');
    if (configured) return configured;
    const legacyOverride = ownString(activeOverride, 'provider');
    if (legacyOverride) return legacyOverride;
    if (cli === 'pi') return entry.defaultProvider || '';
    return inferProvider(entry, model);
}

function modelInventory(entry: RegistryEntry, provider: string): string[] {
    if (provider && Object.prototype.hasOwnProperty.call(entry.modelsByProvider, provider)) {
        return entry.modelsByProvider[provider] ?? [];
    }
    return entry.models;
}

function effortInventory(entry: RegistryEntry, provider: string): string[] {
    if (provider && Object.prototype.hasOwnProperty.call(entry.effortsByProvider, provider)) {
        return entry.effortsByProvider[provider] ?? [];
    }
    return entry.efforts;
}

function defaultSelectionFor(
    cli: string,
    perCli: SettingsRecord,
    entry: RegistryEntry,
): ModelSelection {
    const model = ownString(perCli, 'model') || entry.defaultModel || entry.models[0] || '';
    const provider = ownString(perCli, 'provider')
        || (cli === 'pi' ? entry.defaultProvider : inferProvider(entry, model));
    return {
        cli,
        provider,
        model,
        effort: ownString(perCli, 'effort') ?? entry.defaultEffort,
    };
}

function effectiveSelectionFor(
    cli: string,
    perCli: SettingsRecord,
    activeOverride: SettingsRecord,
    entry: RegistryEntry,
): ModelSelection {
    const model = ownString(activeOverride, 'model')
        || ownString(perCli, 'model')
        || entry.defaultModel
        || entry.models[0]
        || '';
    return {
        cli,
        provider: effectiveProvider(cli, perCli, activeOverride, entry, model),
        model,
        effort: ownString(activeOverride, 'effort')
            ?? ownString(perCli, 'effort')
            ?? entry.defaultEffort,
    };
}

function catalogFor(
    cli: string,
    selection: ModelSelection,
    entries: Record<string, RegistryEntry>,
): ModelCatalog {
    const entry = entries[cli];
    const emptyEntry: RegistryEntry = {
        defaultProvider: '', defaultModel: '', defaultEffort: '',
        providers: [], models: [], efforts: [], modelsByProvider: {}, effortsByProvider: {},
    };
    const resolved = entry ?? emptyEntry;
    const providerValues = resolved.providers.length > 0
        ? resolved.providers
        : Object.keys(resolved.modelsByProvider);
    const piProvider = selection.provider || resolved.defaultProvider;
    const providers = cli === 'pi'
        ? (piProvider ? [piProvider] : [])
        : providerValues;
    const rawModels = modelInventory(resolved, selection.provider);
    const rawEfforts = effortInventory(resolved, selection.provider);
    const modelsByProvider = Object.fromEntries(
        Object.entries(resolved.modelsByProvider).map(([provider, values]) => [provider, options(values)]),
    );
    const effortsByProvider = Object.fromEntries(
        Object.entries(resolved.effortsByProvider).map(([provider, values]) => [provider, options(values, undefined, true)]),
    );
    const piInventoryTrusted = cli !== 'pi'
        || !selection.provider
        || selection.provider === resolved.defaultProvider
        || Object.prototype.hasOwnProperty.call(resolved.modelsByProvider, selection.provider);
    const mutationEnabled = entry !== undefined && rawModels.length > 0 && piInventoryTrusted;
    return {
        cli,
        cliOptions: options(Object.keys(entries), entries[cli] ? undefined : cli),
        providerOptions: options(providers, selection.provider || undefined),
        modelOptions: options(rawModels, selection.model || undefined),
        effortOptions: options(rawEfforts, selection.effort, true),
        modelsByProvider,
        effortsByProvider,
        registryDefaultProvider: resolved.defaultProvider,
        registryDefaultModel: resolved.defaultModel,
        registryDefaultEffort: resolved.defaultEffort,
        providerMutable: cli !== 'pi' && providerValues.length > 1,
        mutationEnabled,
        mutationDisabledReason: mutationEnabled
            ? null
            : entry === undefined
                ? 'CLI registry is unavailable for the current CLI.'
                : rawModels.length === 0
                    ? 'The current CLI has no live model inventory.'
                    : 'This Pi profile has no profile-aware live model inventory.',
    };
}

export function adaptModelSettings(
    settings: SettingsRecord,
    cliRegistry: SettingsRecord,
    mode: ModelMutationMode = 'active',
): AdaptedModelSettings {
    const entries = registryEntries(cliRegistry);
    const perCliRoot = recordAt(settings, 'perCli');
    const activeRoot = recordAt(settings, 'activeOverrides');
    const configuredCli = ownString(settings, 'cli');
    const cli = configuredCli || Object.keys(perCliRoot)[0] || Object.keys(entries)[0] || '';
    const entry = entries[cli] ?? {
        defaultProvider: '', defaultModel: '', defaultEffort: '',
        providers: [], models: [], efforts: [], modelsByProvider: {}, effortsByProvider: {},
    };
    const perCli = recordAt(perCliRoot, cli);
    const activeOverride = recordAt(activeRoot, cli);
    const defaultSelection = defaultSelectionFor(cli, perCli, entry);
    const selection = effectiveSelectionFor(cli, perCli, activeOverride, entry);
    return {
        selection,
        defaultSelection,
        catalog: catalogFor(cli, mode === 'default' ? defaultSelection : selection, entries),
        hasActiveOverride: ownString(activeOverride, 'model') !== undefined
            || ownString(activeOverride, 'effort') !== undefined,
        activeOverrideMasksDefault: selection.provider !== defaultSelection.provider
            || selection.model !== defaultSelection.model
            || selection.effort !== defaultSelection.effort,
    };
}

function values(items: readonly ModelOption[]): string[] {
    return items.filter(item => !item.synthetic).map(item => item.value);
}

function inventoryForProvider(
    catalog: ModelCatalog,
    provider: string,
    kind: 'model' | 'effort',
): string[] {
    const byProvider = kind === 'model' ? catalog.modelsByProvider : catalog.effortsByProvider;
    if (provider && Object.prototype.hasOwnProperty.call(byProvider, provider)) {
        return values(byProvider[provider] ?? []);
    }
    return values(kind === 'model' ? catalog.modelOptions : catalog.effortOptions);
}

export function revalidateModelSelection(
    current: ModelSelection,
    requested: ModelSelection,
    catalog: ModelCatalog,
): ModelSelection {
    if (requested.cli !== catalog.cli || current.cli !== catalog.cli) {
        throw new Error('Model selection CLI does not match the catalog');
    }
    const providerValues = values(catalog.providerOptions);
    const provider = catalog.cli === 'pi'
        ? current.provider || catalog.registryDefaultProvider
        : providerValues.includes(requested.provider)
            ? requested.provider
            : current.provider;
    const providerChanged = provider !== current.provider;
    const models = inventoryForProvider(catalog, provider, 'model');
    const efforts = inventoryForProvider(catalog, provider, 'effort').filter(value => value !== '');
    const preserveUnknownModel = !providerChanged && requested.model === current.model;
    const model = models.includes(requested.model) || preserveUnknownModel
        ? requested.model
        : models.includes(catalog.registryDefaultModel)
            ? catalog.registryDefaultModel
            : models[0] || current.model;
    const preserveUnknownEffort = !providerChanged && requested.effort === current.effort;
    const effort = requested.effort === '' || efforts.includes(requested.effort) || preserveUnknownEffort
        ? requested.effort
        : efforts.includes(catalog.registryDefaultEffort)
            ? catalog.registryDefaultEffort
            : '';
    return { cli: current.cli, provider, model, effort };
}

export function buildModelSettingsPatch(
    selection: ModelSelection,
    mode: ModelMutationMode,
    previous?: AdaptedModelSettings,
): SettingsRecord {
    if (mode === 'active') {
        const providerChanged = previous !== undefined
            && selection.provider !== previous.selection.provider;
        const compatibleDefault = providerChanged
            ? revalidateModelSelection(previous.defaultSelection, {
                ...previous.defaultSelection,
                provider: selection.provider,
            }, previous.catalog)
            : null;
        return {
            perCli: {
                [selection.cli]: {
                    provider: selection.provider,
                    ...(compatibleDefault ? {
                        model: compatibleDefault.model,
                        effort: compatibleDefault.effort,
                    } : {}),
                },
            },
            activeOverrides: {
                [selection.cli]: { model: selection.model, effort: selection.effort },
            },
        };
    }
    const patch: SettingsRecord = {
        perCli: {
            [selection.cli]: {
                provider: selection.provider,
                model: selection.model,
                effort: selection.effort,
            },
        },
    };
    const providerChanged = previous !== undefined
        && selection.provider !== previous.defaultSelection.provider;
    if (providerChanged && previous.hasActiveOverride) {
        const compatibleActive = revalidateModelSelection(previous.selection, {
            ...previous.selection,
            provider: selection.provider,
        }, previous.catalog);
        patch['activeOverrides'] = {
            [selection.cli]: { model: compatibleActive.model, effort: compatibleActive.effort },
        };
    }
    return patch;
}

export function adaptSavedModelSettings(
    settings: SettingsRecord,
    previous: AdaptedModelSettings,
    mode: ModelMutationMode = 'active',
): AdaptedModelSettings {
    const cli = previous.selection.cli;
    const perCli = recordAt(recordAt(settings, 'perCli'), cli);
    const activeOverride = recordAt(recordAt(settings, 'activeOverrides'), cli);
    const entry: RegistryEntry = {
        defaultProvider: previous.catalog.registryDefaultProvider,
        defaultModel: previous.catalog.registryDefaultModel,
        defaultEffort: previous.catalog.registryDefaultEffort,
        providers: values(previous.catalog.providerOptions),
        models: values(previous.catalog.modelOptions),
        efforts: values(previous.catalog.effortOptions).filter(value => value !== ''),
        modelsByProvider: Object.fromEntries(
            Object.entries(previous.catalog.modelsByProvider).map(([provider, items]) => [provider, values(items)]),
        ),
        effortsByProvider: Object.fromEntries(
            Object.entries(previous.catalog.effortsByProvider).map(([provider, items]) => [provider, values(items)]),
        ),
    };
    const defaultSelection = defaultSelectionFor(cli, perCli, entry);
    const selection = effectiveSelectionFor(cli, perCli, activeOverride, entry);
    return {
        selection,
        defaultSelection,
        catalog: {
            ...catalogFor(cli, mode === 'default' ? defaultSelection : selection, { [cli]: entry }),
            cliOptions: previous.catalog.cliOptions,
        },
        hasActiveOverride: ownString(activeOverride, 'model') !== undefined
            || ownString(activeOverride, 'effort') !== undefined,
        activeOverrideMasksDefault: selection.provider !== defaultSelection.provider
            || selection.model !== defaultSelection.model
            || selection.effort !== defaultSelection.effort,
    };
}
