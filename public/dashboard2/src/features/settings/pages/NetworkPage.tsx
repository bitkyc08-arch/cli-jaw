import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function NetworkPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Network" description="Control outbound proxying and transport security." source="instance" adapterId="unsupported" port={port} dirty={dirty} fields={[
        { key: 'proxyUrl', label: 'Proxy URL', description: 'HTTP or SOCKS proxy for outbound requests.', kind: 'text', placeholder: 'http://127.0.0.1:8080', unsupported: 'Network settings are planned for 089.14.' },
        { key: 'tlsVerify', label: 'Verify TLS certificates', description: 'Reject invalid or untrusted certificates.', kind: 'toggle', unsupported: 'Network settings are planned for 089.14.' },
        { key: 'bindHost', label: 'Bind host', kind: 'text', placeholder: '127.0.0.1', unsupported: 'Network settings are deferred to avoid partial remoteAccess replacement.' },
        { key: 'trustProxy', label: 'Trust proxy headers', kind: 'toggle', unsupported: 'Network settings are deferred to avoid partial remoteAccess replacement.' },
    ]} />;
}
