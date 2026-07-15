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
}

export interface SettingsToastState {
    kind: 'success' | 'error';
    message: string;
}
