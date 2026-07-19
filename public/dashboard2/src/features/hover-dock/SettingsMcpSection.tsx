import { useCallback, useEffect, useState } from 'react';
import type { DockClient } from './dock-client';
import { unwrapData } from './dock-settings';

interface McpServer { command?: string; args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }
interface McpData { servers: Record<string, McpServer> }

type Props = { client: DockClient; active: boolean };

function serverTag(server: McpServer): string | null {
    if (server.url) return 'remote';
    const cmd = server.command || '';
    if (!cmd) return null;
    if (cmd === 'npx' || cmd.endsWith('/npx')) return 'npx';
    if (cmd === 'uvx' || cmd === 'uv' || cmd.endsWith('/uvx')) return 'uvx';
    if (cmd === 'docker' || cmd.endsWith('/docker')) return 'docker';
    return null;
}

// 050 감사 반영 — 모달 상당 로컬 검증
function validateMcpConfig(raw: string): { config?: McpData; error?: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return { error: `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!parsed || typeof parsed !== 'object' || !('servers' in parsed)) {
        return { error: 'servers 객체가 필요합니다' };
    }
    const servers = (parsed as McpData).servers;
    if (!servers || typeof servers !== 'object') return { error: 'servers 객체가 필요합니다' };
    for (const [name, server] of Object.entries(servers)) {
        if (!name.trim()) return { error: '서버 이름이 비어 있습니다' };
        if (!server || typeof server !== 'object') return { error: `${name}: 설정이 객체가 아닙니다` };
        if (!server.command && !server.url) return { error: `${name}: command 또는 url이 필요합니다` };
        if (server.env && typeof server.env !== 'object') return { error: `${name}: env는 객체여야 합니다` };
        if (server.headers && typeof server.headers !== 'object') return { error: `${name}: headers는 객체여야 합니다` };
    }
    return { config: parsed as McpData };
}

export function SettingsMcpSection({ client, active }: Props) {
    const [data, setData] = useState<McpData | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [message, setMessage] = useState<string | null>(null);

    const load = useCallback(() => {
        client.get<unknown>('/api/mcp')
            .then((json) => {
                const next = unwrapData<McpData>(json);
                setData(next);
                setDraft(JSON.stringify(next, null, 2));
            })
            .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)));
    }, [client]);

    useEffect(() => {
        if (active) load();
    }, [active, load]);

    const runAction = useCallback((path: string, label: string) => {
        setMessage(`${label} 중...`);
        client.post<unknown>(path, {})
            .then((json) => {
                const result = unwrapData<Record<string, unknown>>(json);
                setMessage(`${label} 완료: ${Object.keys(result['results'] || result).join(', ') || 'ok'}`);
                load();
            })
            .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)));
    }, [client, load]);

    const saveConfig = useCallback(() => {
        const { config, error } = validateMcpConfig(draft);
        if (error || !config) {
            setMessage(error || 'invalid config');
            return;
        }
        client.put('/api/mcp', config)
            .then(() => {
                setMessage('저장됨');
                load();
            })
            .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)));
    }, [client, draft, load]);

    const bundleCount = data
        ? Object.values(data.servers || {}).filter((s) => s.command === 'npx' || s.command === 'uv' || s.command === 'uvx').length
        : 0;

    return (
        <div className="dock-section">
            <div className="dock-section-header dock-section-header-static"><span>MCP</span></div>
            {!data && <div className="dock-loading">로딩 중...</div>}
            {data && Object.entries(data.servers || {}).map(([name, server]) => (
                <div key={name} className="dock-mcp-row">
                    <b>{name}</b>{' '}
                    <span className="dock-dim">
                        {server.url || [server.command, ...(server.args || []).slice(0, 2)].filter(Boolean).join(' ')}
                    </span>
                    {serverTag(server) && <span className="dock-chip">{serverTag(server)}</span>}
                </div>
            ))}
            {data && Object.keys(data.servers || {}).length === 0 && <div className="dock-dim">등록된 MCP 서버 없음</div>}
            <div className="dock-row">
                <button type="button" className="dock-mini-btn" onClick={() => setEditorOpen((prev) => !prev)}>
                    {editorOpen ? '편집 닫기' : 'Add / Set (JSON)'}
                </button>
                <button type="button" className="dock-mini-btn" onClick={() => runAction('/api/mcp/sync', 'sync')}>Sync to all CLIs</button>
                <button type="button" className="dock-mini-btn" disabled={bundleCount === 0} onClick={() => runAction('/api/mcp/install', 'install')}>
                    Install bundle ({bundleCount})
                </button>
            </div>
            {editorOpen && (
                <>
                    <textarea className="dock-prompt-editor" value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="dock-row"><button type="button" className="dock-mini-btn" onClick={saveConfig}>MCP 저장</button></div>
                </>
            )}
            {message && <div className="dock-dim">{message}</div>}
        </div>
    );
}
