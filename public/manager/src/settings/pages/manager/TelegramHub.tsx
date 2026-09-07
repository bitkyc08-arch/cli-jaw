import type { SettingsPageProps } from '../../types';
import TelegramHubPage from '../TelegramHub';
export default function TelegramHub(props: SettingsPageProps) {
    return props.manager ? <TelegramHubPage {...props}/> : null;
}
