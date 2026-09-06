import { SelectField } from '../../../fields';
import { SettingsSection } from '../../page-shell';
import {
    configuredPolicyLabel,
    isAllowlistValid,
    parsePermissionsValue,
    seedAutoAllowlist,
} from '../../Permissions';

type PermissionQuickSectionProps = {
    value: unknown;
    configuredValue: unknown;
    onChange(next: 'auto' | string[]): void;
};

const MODE_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'custom', label: 'Custom allowlist' },
];

export function PermissionQuickSection({ value, configuredValue, onChange }: PermissionQuickSectionProps) {
    const parsed = parsePermissionsValue(value);
    const mode = parsed.mode === 'custom' ? 'custom' : 'auto';
    const tokens = parsed.mode === 'custom' ? parsed.tokens : [];
    const summary = parsed.mode === 'custom'
        ? `Editor draft: ${tokens.length} explicit token${tokens.length === 1 ? '' : 's'}`
        : null;

    return (
        <SettingsSection
            title="Permissions"
            hint="Selecting a value changes the draft. Save applies it."
        >
            <SelectField
                id="agent-permissions-mode"
                label="Change policy to"
                value={mode}
                options={MODE_OPTIONS}
                onChange={(next) => {
                    if (next === 'auto') onChange('auto');
                    else onChange(tokens.length > 0 && isAllowlistValid(tokens) ? tokens : seedAutoAllowlist(null));
                }}
            />
            {summary ? <p className="settings-agent-note">{summary}</p> : null}
            <p className="settings-agent-note" id="agent-configured-policy">Configured policy: {configuredPolicyLabel(configuredValue)}</p>
        </SettingsSection>
    );
}
