import type { ComponentType } from 'react';
import type { DirtyStore } from './settings-dirty-store.ts';

export type SettingsPageId =
    | 'display'
    | 'agent'
    | 'model-provider'
    | 'network'
    | 'memory'
    | 'mcp'
    | 'profile'
    | 'browser';

export type SettingsSource = 'dashboard' | 'instance';
export type SettingsRecord = Record<string, unknown>;
export type InstanceSettingsAdapterId = 'agent' | 'memory' | 'network' | 'unsupported';

export interface SettingsPageProps {
    port: number | null;
    dirty: DirtyStore;
}

export interface SettingsCategory {
    id: SettingsPageId;
    label: string;
    description: string;
    source: SettingsSource;
    page: ComponentType<SettingsPageProps>;
}

export type SettingsFieldKind = 'text' | 'number' | 'select' | 'toggle' | 'secret' | 'textarea';

export interface SettingsFieldDefinition {
    key: string;
    label: string;
    description?: string;
    kind: SettingsFieldKind;
    placeholder?: string;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ label: string; value: string }>;
    unsupported?: string;
    required?: boolean;
    validate?(value: unknown, draft: SettingsRecord): string | null;
    errorKey?: string;
}

export function validateSettingsField(
    field: SettingsFieldDefinition,
    value: unknown,
    draft: SettingsRecord,
): string | null {
    if (field.unsupported) return null;
    if (field.required && (value === undefined || value === null || (typeof value === 'string' && !value.trim()))) {
        return `${field.label} is required.`;
    }
    if (field.kind === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${field.label} must be a number.`;
        if (field.min !== undefined && value < field.min) return `${field.label} must be at least ${field.min}.`;
        if (field.max !== undefined && value > field.max) return `${field.label} must be at most ${field.max}.`;
        if (field.step === 1 && !Number.isInteger(value)) return `${field.label} must be a whole number.`;
    }
    if (field.kind === 'select' && field.options && !field.options.some(option => option.value === value)) {
        return `Choose a valid ${field.label.toLocaleLowerCase()}.`;
    }
    return field.validate?.(value, draft) ?? null;
}

export interface SettingsToastState {
    kind: 'success' | 'error';
    message: string;
}
