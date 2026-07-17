import { Check, ChevronDown, LoaderCircle } from '@lucide/icons';
import { useId, type JSX } from 'react';
import { useSelect } from 'downshift';
import { Icon } from '../shell/Icon.tsx';
import type { ModelCatalog, ModelSelection } from './model-settings-adapter.ts';

export interface ModelPickerOption {
    id: string;
    provider: string;
    model: string;
    label: string;
    description?: string;
}

export interface ModelPickerProps {
    label?: string;
    value: ModelPickerOption | null;
    options: readonly ModelPickerOption[];
    effort?: string;
    loading?: boolean;
    pending?: boolean;
    disabled?: boolean;
    error?: string | null;
    compact?: boolean;
    workerWide?: boolean;
    placement?: 'above' | 'below';
    onSelect(option: ModelPickerOption): void;
}

function itemText(item: ModelPickerOption | null): string {
    return item ? [item.provider, item.model].filter(Boolean).join(' · ') : '';
}

export function modelPickerOptions(
    catalog: ModelCatalog | null,
    selection: ModelSelection | null,
): ModelPickerOption[] {
    if (!catalog || !selection) return [];
    const providers = catalog.providerOptions.map(option => option.value)
        .filter((provider, index, all) => provider && all.indexOf(provider) === index);
    if (providers.length === 0) providers.push(selection.provider);
    const result: ModelPickerOption[] = [];
    const seen = new Set<string>();
    for (const provider of providers) {
        const source = catalog.modelsByProvider[provider]
            ?? (provider === selection.provider ? catalog.modelOptions : []);
        for (const model of source) {
            const id = `${provider}\u0000${model.value}`;
            if (seen.has(id)) continue;
            seen.add(id);
            result.push({
                id,
                provider,
                model: model.value,
                label: model.label,
                description: model.synthetic ? `${provider || 'default'} · current custom model` : provider,
            });
        }
    }
    const selectedId = `${selection.provider}\u0000${selection.model}`;
    if (selection.model && !seen.has(selectedId)) {
        result.unshift({
            id: selectedId,
            provider: selection.provider,
            model: selection.model,
            label: selection.model,
            description: `${selection.provider || 'default'} · current custom model`,
        });
    }
    return result;
}

export function ModelPicker({
    label = 'Provider and model', value, options, effort = '', loading = false,
    pending = false, disabled = false, error = null, compact = false,
    workerWide = false, placement = 'above', onSelect,
}: ModelPickerProps): JSX.Element {
    const inputId = useId();
    const selectedItem = options.find(option => option.id === value?.id) ?? value;
    const unavailable = disabled || loading || pending || options.length === 0;
    const {
        isOpen,
        highlightedIndex,
        getLabelProps,
        getToggleButtonProps,
        getMenuProps,
        getItemProps,
    } = useSelect({
        id: inputId,
        items: [...options],
        selectedItem,
        itemToString: itemText,
        isItemDisabled: () => pending,
        onSelectedItemChange: change => {
            if (change.selectedItem) onSelect(change.selectedItem);
        },
    });
    const display = selectedItem
        ? [selectedItem.provider, selectedItem.model, effort].filter(Boolean).join(' · ')
        : loading ? 'Loading models…' : options.length > 0 ? 'Select model…' : 'No models available';
    const scopeDescription = workerWide ? ' Applies to every Chat session on this instance.' : '';

    return (
        <div className={`d2-model-picker${compact ? ' is-compact' : ''}${isOpen ? ' is-open' : ''}${placement === 'below' ? ' opens-below' : ''}`}>
            <span className="d2-model-picker-label" {...getLabelProps()}>{label}</span>
            <button
                type="button"
                className="d2-model-picker-trigger"
                {...getToggleButtonProps({
                    disabled: unavailable,
                    'aria-label': `${label}: ${display}.${scopeDescription}`,
                    title: workerWide ? `${display} — applies to every Chat session on this instance` : display,
                })}
            >
                {loading || pending ? <span className="d2-model-picker-spinner"><Icon icon={LoaderCircle} /></span> : null}
                <span>{display}</span>
                <Icon icon={ChevronDown} aria-hidden="true" />
            </button>
            <ul className="d2-model-picker-menu" {...getMenuProps()}>
                {isOpen ? options.map((option, index) => (
                    <li
                        key={option.id}
                        className={`d2-model-picker-option${highlightedIndex === index ? ' is-highlighted' : ''}${selectedItem?.id === option.id ? ' is-selected' : ''}`}
                        {...getItemProps({ item: option, index })}
                    >
                        <span className="d2-model-picker-check" aria-hidden="true">
                            {selectedItem?.id === option.id ? <Icon icon={Check} /> : null}
                        </span>
                        <span className="d2-model-picker-option-copy">
                            <strong>{option.model}</strong>
                            <small>{option.description || option.provider || 'Default provider'}</small>
                        </span>
                    </li>
                )) : null}
            </ul>
            {workerWide ? <small className="d2-model-picker-scope">Applies to every Chat session on this instance.</small> : null}
            {error ? <div className="d2-model-picker-error" role="alert">{error}</div> : null}
            {loading ? <span className="d2-sr-only" role="status">Loading model inventory</span> : null}
        </div>
    );
}
