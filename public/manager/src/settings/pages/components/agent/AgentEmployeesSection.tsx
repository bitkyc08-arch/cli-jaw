import { SettingsSection } from '../../page-shell';
import { RuntimeEmployeeRow } from './RuntimeEmployeeRow';
import type { CliMeta } from './agent-meta';
import {
    makeDefaultRuntimeEmployee,
    runtimeEmployeeChangeSummary,
    runtimeEmployeesHaveErrors,
    type RuntimeEmployeeRecord,
} from './runtime-employees-helpers';

type AgentEmployeesSectionProps = {
    roster: RuntimeEmployeeRecord[];
    original: RuntimeEmployeeRecord[];
    cliOptions: ReadonlyArray<string>;
    cliMeta?: Record<string, CliMeta> | null;
    loading?: boolean;
    error?: string | null;
    onRosterChange(next: RuntimeEmployeeRecord[]): void;
};

export function AgentEmployeesSection({
    roster,
    original,
    cliOptions,
    cliMeta,
    loading,
    error,
    onRosterChange,
}: AgentEmployeesSectionProps) {
    const summary = runtimeEmployeeChangeSummary(original, roster);
    const hasErrors = runtimeEmployeesHaveErrors(roster);

    function updateRow(idx: number, patch: Partial<RuntimeEmployeeRecord>) {
        onRosterChange(roster.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    }

    function removeRow(idx: number) {
        onRosterChange(roster.filter((_, i) => i !== idx));
    }

    return (
        <SettingsSection
            title="Employees"
            hint="Runtime dispatch roster. Static employees keep their locked identity; database employees can be edited."
        >
            <div className="settings-runtime-employee-summary">
                <span>+{summary.added}</span>
                <span>~{summary.updated}</span>
                <span>-{summary.removed}</span>
                {hasErrors ? <strong>Fix invalid rows before saving.</strong> : null}
            </div>
            {loading ? <p className="settings-agent-note">Loading employees...</p> : null}
            {error ? <p className="settings-field-error" role="alert">{error}</p> : null}
            {roster.length === 0 ? (
                <p className="settings-empty">No runtime employees configured.</p>
            ) : (
                <div className="settings-runtime-employee-list">
                    {roster.map((employee, idx) => (
                        <RuntimeEmployeeRow
                            key={employee.id}
                            employee={employee}
                            index={idx}
                            cliOptions={cliOptions}
                            cliMeta={cliMeta ?? null}
                            onChange={(patch) => updateRow(idx, patch)}
                            onRemove={() => removeRow(idx)}
                        />
                    ))}
                </div>
            )}
            <div className="settings-employee-footer-bar">
                <button
                    type="button"
                    className="settings-action settings-action-discard"
                    onClick={() => onRosterChange([...roster, makeDefaultRuntimeEmployee(cliOptions, cliMeta)])}
                >
                    + Add employee
                </button>
            </div>
        </SettingsSection>
    );
}
