import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function NetworkPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell
        title="Network"
        description="Edit the selected instance's persisted network settings. Saving does not reconfigure the running instance."
        source="instance"
        adapterId="network"
        port={port}
        dirty={dirty}
        fields={[
            { key: 'bindHost', label: 'Bind host', description: 'Listening interface saved for the instance. Takes effect after you restart the instance.', kind: 'text', placeholder: '127.0.0.1' },
            { key: 'lanBypass', label: 'Allow LAN authentication bypass', description: 'Persist whether LAN clients may bypass authentication.', kind: 'toggle' },
            { key: 'remoteAccess.mode', label: 'Remote access mode', description: 'Persist the remote access mode. Takes effect after you restart the instance.', kind: 'select', options: [
                { label: 'Off', value: 'off' },
                { label: 'HTTP only', value: 'http-only' },
                { label: 'Full', value: 'full' },
            ] },
            { key: 'remoteAccess.trustProxies', label: 'Trust proxies', description: 'Persist whether proxy forwarding is trusted. Takes effect after you restart the instance.', kind: 'toggle' },
            { key: 'remoteAccess.trustForwardedFor', label: 'Trust forwarded client IPs', description: 'Persist whether forwarded client IP headers are trusted. Takes effect after you restart the instance.', kind: 'toggle' },
            { key: 'remoteAccess.publicOriginHint', label: 'Public origin hint', description: 'Optional HTTP(S) origin metadata. This setting is persistence-only.', kind: 'text', placeholder: 'https://jaw.example.com' },
            { key: 'remoteAccess.requireAuth', label: 'Require authentication', description: 'Persist the remote-access authentication requirement. This setting is persistence-only.', kind: 'toggle' },
        ]}
    />;
}
