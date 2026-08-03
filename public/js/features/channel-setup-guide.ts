// ── Channel Setup Guide Popup ──
// When a user points cli-jaw at a channel that has no credentials, open the
// existing help dialog's setup guide instead of leaving a silently dead
// channel. Fires only on explicit user intent: switching the active channel
// or enabling a channel toggle — never on page load, so a settings visit
// does not pop a dialog the user did not ask for.
import { openHelpDialog } from './help-dialog.js';
import { isTelegramConfigured, isDiscordConfigured, isSlackConfigured } from './channel-setup-rules.js';

type SetupChannel = 'telegram' | 'discord' | 'slack';

function inputValue(id: string): string {
    return (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
}

/** Open the channel's setup guide when its required credentials are missing. */
export function openSetupGuideIfUnconfigured(ch: SetupChannel): void {
    const configured =
        ch === 'telegram' ? isTelegramConfigured(inputValue('tgToken')) :
        ch === 'discord' ? isDiscordConfigured(inputValue('dcToken'), inputValue('dcGuildId')) :
        isSlackConfigured(inputValue('slBotToken'));
    if (!configured) openHelpDialog(ch);
}
