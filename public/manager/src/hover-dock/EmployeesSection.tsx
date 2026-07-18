import { useCallback, useEffect, useState } from 'react';
import type { SettingsClient } from '../settings/types';
import { ROLE_PRESETS, type CliRegistry } from './cli-registry';

interface Employee {
    id: string;
    name?: string;
    cli: string;
    model?: string;
    role?: string;
    status?: string;
    phase?: string;
    phaseLabel?: string;
    /** 'static' → built-in; CLI/name/role/delete locked, only model editable. */
    source?: 'db' | 'static';
}

type Props = {
    client: SettingsClient;
    active: boolean;
    registry: CliRegistry;
    modelMap: Record<string, string[]>;
};

const LEGACY_ROLE_MAP: Record<string, string> = {
    'React/Vue 기반 UI 컴포넌트 개발, 스타일링': 'frontend',
    'API 서버, DB 스키마, 비즈니스 로직 구현': 'backend',
    '프론트엔드와 백엔드 모두 담당': 'frontend',
    'CI/CD, Docker, 인프라 자동화': 'backend',
    '테스트 작성, 버그 재현, 품질 관리': 'custom',
};

function presetOf(employee: Employee): string {
    const legacy = LEGACY_ROLE_MAP[employee.role || ''];
    if (legacy) return legacy;
    const matched = ROLE_PRESETS.find((preset) => preset.prompt === employee.role);
    if (matched) return matched.value;
    return employee.role ? 'custom' : 'frontend';
}

export function EmployeesSection({ client, active, registry, modelMap }: Props) {
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(() => {
        setError(null);
        client.get<Employee[]>('/api/employees')
            .then((data) => setEmployees(Array.isArray(data) ? data : []))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, [client]);

    // Refetch on every panel open (stale employee prevention — sidebar.ts:87-99 parity).
    useEffect(() => {
        if (active) reload();
    }, [active, reload]);

    const mutate = useCallback((action: Promise<unknown>) => {
        setError(null);
        action.then(reload).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, [reload]);

    const addEmployee = () => mutate(client.post('/api/employees', {}));
    const updateEmployee = (id: string, patch: Partial<Employee>) => mutate(client.put(`/api/employees/${id}`, patch));
    const deleteEmployee = (id: string) => mutate(client.delete(`/api/employees/${id}`));

    const handleCliChange = (employee: Employee, nextCli: string) => {
        const nextModel = (modelMap[nextCli] || [])[0] || 'default';
        updateEmployee(employee.id, { cli: nextCli, model: nextModel });
    };

    const handleRoleChange = (employee: Employee, presetValue: string) => {
        const preset = ROLE_PRESETS.find((item) => item.value === presetValue);
        if (presetValue === 'custom') return; // textarea handles the save on blur
        updateEmployee(employee.id, { role: preset?.prompt || '' });
    };

    const cliKeys = Object.keys(registry);

    return (
        <div className="dock-section">
            <div className="dock-section-header dock-section-header-static">
                <span>직원</span>
                <button type="button" className="dock-mini-btn" onClick={addEmployee}>+ 추가</button>
            </div>
            {error && <div className="dock-error">{error}</div>}
            {employees.length === 0 && !error && <div className="dock-dim">직원을 추가하세요</div>}
            {employees.map((employee) => {
                const isStatic = employee.source === 'static';
                const models = modelMap[employee.cli] || [];
                const model = employee.model || 'default';
                const preset = presetOf(employee);
                return (
                    <div key={employee.id} className={`dock-emp${isStatic ? ' is-static' : ''}`}>
                        <div className="dock-emp-head">
                            {isStatic
                                ? <span className="dock-emp-name">{employee.name || 'Agent'}</span>
                                : (
                                    <input
                                        className="dock-emp-name-input"
                                        defaultValue={employee.name || 'Agent'}
                                        onBlur={(event) => {
                                            const value = event.target.value.trim();
                                            if (value && value !== employee.name) updateEmployee(employee.id, { name: value });
                                        }}
                                    />
                                )}
                            {isStatic && <span className="dock-emp-builtin">BUILT-IN</span>}
                            {!isStatic && (
                                <button type="button" className="dock-mini-btn" title="삭제" onClick={() => deleteEmployee(employee.id)}>×</button>
                            )}
                        </div>
                        <div className="dock-emp-grid">
                            <label className="dock-field">
                                <span>CLI</span>
                                {isStatic
                                    ? <select disabled value={employee.cli}><option>{employee.cli}</option></select>
                                    : (
                                        <select value={employee.cli} onChange={(event) => handleCliChange(employee, event.target.value)}>
                                            {cliKeys.map((key) => <option key={key} value={key}>{key}</option>)}
                                        </select>
                                    )}
                            </label>
                            <label className="dock-field">
                                <span>모델</span>
                                <select value={model} onChange={(event) => updateEmployee(employee.id, { model: event.target.value })}>
                                    <option value="default">default</option>
                                    {models.map((item) => <option key={item} value={item}>{item}</option>)}
                                    {model !== 'default' && !models.includes(model) && <option value={model}>{model}</option>}
                                </select>
                            </label>
                        </div>
                        <label className="dock-field">
                            <span>Role</span>
                            {isStatic
                                ? <div className="dock-dim">{employee.role || ''}</div>
                                : (
                                    <>
                                        <select value={preset} onChange={(event) => handleRoleChange(employee, event.target.value)}>
                                            {ROLE_PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                                        </select>
                                        {preset === 'custom' && (
                                            <textarea
                                                className="dock-emp-custom"
                                                defaultValue={employee.role || ''}
                                                onBlur={(event) => updateEmployee(employee.id, { role: event.target.value })}
                                            />
                                        )}
                                    </>
                                )}
                        </label>
                        <div className="dock-emp-status">
                            <span className={employee.status === 'running' ? 'dock-status-running' : 'dock-status-idle'}>
                                {employee.status || 'idle'}
                            </span>
                            {(employee.phase || employee.phaseLabel) && (
                                <span className="dock-emp-phase">{employee.phaseLabel || `P${employee.phase}`}</span>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
