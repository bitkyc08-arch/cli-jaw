import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function DisplayPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Display" description="Choose how the dashboard looks and reads." source="dashboard" slice="ui" port={port} dirty={dirty} fields={[
        { key: 'uiTheme', label: 'Theme', description: 'Follow your system or choose a fixed theme.', kind: 'select', options: [{ label: 'System', value: 'auto' }, { label: 'Dark', value: 'dark' }, { label: 'Light', value: 'light' }] },
        { key: 'locale', label: 'Language', description: 'Dashboard interface language.', kind: 'select', options: [{ label: '한국어', value: 'ko' }, { label: 'English', value: 'en' }, { label: '中文', value: 'zh' }, { label: '日本語', value: 'ja' }] },
        { key: 'fontSize', label: 'Font size', description: 'Base dashboard text size in pixels.', kind: 'number', min: 11, max: 24, step: 1 },
    ]} />;
}
