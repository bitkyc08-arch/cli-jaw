import type { CodePermissionMode } from '../../../../src/code-mode/wire';
import { CodeFooterMenu } from './ComposerFooter';
import { CODE_POLICY_LABELS, CODE_POLICY_DETAILS } from './code-types';

export function CodePermissionModePicker({ value, modes, disabled = false, onChange }: {
    value: CodePermissionMode;
    modes: CodePermissionMode[];
    disabled?: boolean;
    onChange: (value: CodePermissionMode) => void;
}) {
    return <CodeFooterMenu label="Permission" value={value} displayValue={CODE_POLICY_LABELS[value]} disabled={disabled || modes.length === 0}
        options={modes.map(mode => ({ value: mode, label: CODE_POLICY_LABELS[mode], detail: CODE_POLICY_DETAILS[mode] }))}
        onChange={onChange} />;
}
