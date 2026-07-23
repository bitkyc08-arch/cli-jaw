import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function BrowserPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Browser" description="Choose how the embedded browser panel behaves." source="dashboard" slice="browser" port={port} dirty={dirty} fields={[
        { key: 'defaultUrl', label: 'Default URL', kind: 'text', placeholder: 'about:blank', unsupported: 'The dashboard registry has no browser persistence slice.' },
        { key: 'openDevTools', label: 'Open developer tools', kind: 'toggle', unsupported: 'The dashboard registry has no browser persistence slice.' },
        { key: 'preserveSessions', label: 'Preserve browser sessions', description: 'Keep cookies and storage between launches.', kind: 'toggle', unsupported: 'The dashboard registry has no browser persistence slice.' },
        { key: 'zoom', label: 'Default zoom', description: 'Page zoom percentage.', kind: 'number', min: 50, max: 200, step: 5, unsupported: 'The dashboard registry has no browser persistence slice.' },
    ]} />;
}
