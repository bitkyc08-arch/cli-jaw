import type { JSX } from 'react';
import { ModelSettingsPanel } from '../../../models/ModelSettingsPanel.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function ModelProviderPage({ port }: SettingsPageProps): JSX.Element {
    return <ModelSettingsPanel
        port={port}
        mode="default"
        title="Model providers"
        description="Choose from the selected instance’s live provider/model inventory. Credentials stay managed by each CLI and are never displayed here."
    />;
}
