import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function BrowserPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Browser" description="Choose how the embedded browser panel behaves." source="dashboard" slice="browser" port={port} dirty={dirty} fields={[
        { key: 'defaultUrl', label: 'Default URL', kind: 'text', placeholder: 'about:blank' },
        { key: 'openDevTools', label: 'Open developer tools', kind: 'toggle' },
        { key: 'preserveSessions', label: 'Preserve browser sessions', description: 'Keep cookies and storage between launches.', kind: 'toggle' },
        { key: 'zoom', label: 'Default zoom', description: 'Page zoom percentage.', kind: 'number', min: 50, max: 200, step: 5 },
    ]} />;
}
