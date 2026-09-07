import type { SettingsPageProps } from '../../types';
import { DashboardDeveloperSettingsSection } from '../../../dashboard-settings/DashboardDeveloperSettingsSection';
import { normalizeDashboardLocale } from './shared';
export default function Developer({manager}: SettingsPageProps) {
    return manager ? <DashboardDeveloperSettingsSection locale={normalizeDashboardLocale(manager.ui.locale)}
        ui={manager.ui} onUiPatch={manager.onUiPatch}/> : null;
}
