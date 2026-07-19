import { useCallback, useEffect, useState } from 'react';
import type { DockClient } from './dock-client';
import { unwrapData, type SettingsData } from './dock-settings';
import type { DockSettingsSnapshot } from './HoverDock';
import { parseChannelHealth, type ChannelHealth } from './channel-health';
import { DockSwitch } from './DockSwitch';

type Props = {
    client: DockClient;
    active: boolean;
    settings: SettingsData;
    snapshot: DockSettingsSnapshot;
};

function TogglePair(props: { label: string; value: boolean; onChange: (next: boolean) => void }) {
    return (
        <div className="dock-row dock-toggle-row">
            <span className="dock-field-label">{props.label}</span>
            <DockSwitch checked={props.value} onChange={props.onChange} ariaLabel={props.label} />
        </div>
    );
}

export function SettingsChannelsSection({ client, active, settings, snapshot }: Props) {
    const [health, setHealth] = useState<ChannelHealth | null>(null);
    const [error, setError] = useState<string | null>(null);
    // 텍스트 필드는 명시 저장(토글=즉시 저장과 분리, 040 혼합 저장 모델)
    const [tgToken, setTgToken] = useState(settings.telegram?.token || '');
    const [tgChatIds, setTgChatIds] = useState((settings.telegram?.allowedChatIds || []).join(', '));
    const [dcToken, setDcToken] = useState(settings.discord?.token || '');
    const [dcGuildId, setDcGuildId] = useState(settings.discord?.guildId || '');
    const [dcChannelIds, setDcChannelIds] = useState((settings.discord?.channelIds || []).join(', '));
    const [fallback, setFallback] = useState<string[]>(settings.fallbackOrder || []);

    const refreshHealth = useCallback(() => {
        client.get<unknown>('/api/health')
            .then((payload) => setHealth(parseChannelHealth(unwrapData<unknown>(payload))))
            .catch(() => setHealth(null));
    }, [client]);

    useEffect(() => {
        if (active) refreshHealth();
    }, [active, refreshHealth]);

    const putSettings = useCallback(async (patch: Record<string, unknown>) => {
        setError(null);
        try {
            const next = unwrapData<SettingsData>(await client.put<unknown>('/api/settings', patch));
            snapshot.setData(next);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [client, snapshot]);

    const setChannel = useCallback((channel: 'telegram' | 'discord') => {
        void putSettings({ channel }).then(refreshHealth);
    }, [putSettings, refreshHealth]);

    const saveTelegramText = useCallback(() => {
        const allowedChatIds = tgChatIds.split(',').map((raw) => parseInt(raw.trim(), 10)).filter((n) => !isNaN(n));
        void putSettings({ telegram: { token: tgToken.trim(), allowedChatIds } });
    }, [putSettings, tgToken, tgChatIds]);

    const saveDiscordText = useCallback(() => {
        const channelIds = dcChannelIds.split(',').map((raw) => raw.trim()).filter(Boolean);
        void putSettings({ discord: { token: dcToken.trim(), guildId: dcGuildId.trim(), channelIds } });
    }, [putSettings, dcToken, dcGuildId, dcChannelIds]);

    const saveFallback = useCallback(() => {
        void putSettings({ fallbackOrder: fallback.filter(Boolean) });
    }, [putSettings, fallback]);

    const channel = settings.channel || 'telegram';
    const tg = settings.telegram || {};
    const dc = settings.discord || {};
    const cliKeys = Object.keys(settings.perCli || {});
    const slotCount = Math.min(Math.max(cliKeys.length - 1, 0), 3);

    return (
        <div className="dock-section">
            <div className="dock-section-header dock-section-header-static"><span>Active Channel</span></div>
            <div className="dock-row">
                <span className="dock-toggle-group">
                    <button type="button" className={`dock-toggle${channel === 'telegram' ? ' is-active' : ''}`} onClick={() => setChannel('telegram')}>TG</button>
                    <button type="button" className={`dock-toggle${channel === 'discord' ? ' is-active' : ''}`} onClick={() => setChannel('discord')}>DC</button>
                </span>
            </div>
            {health && (
                <div className="dock-health">
                    {(['telegram', 'discord'] as const).map((name) => (
                        <div key={name} className="dock-health-row">
                            <span className="dock-field-label">{name === 'telegram' ? 'Telegram' : 'Discord'}</span>
                            <span className="dock-health-chips">
                                <span className="dock-chip">{health[name].configured ? 'configured' : 'not configured'}</span>
                                {health[name].sendCapable && <span className="dock-chip">send</span>}
                                {health[name].activeInbound && <span className="dock-chip">inbound</span>}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {error && <div className="dock-error">{error}</div>}

            {channel === 'telegram' && (
                <div className="dock-channel">
                    <TogglePair label="Telegram 활성화" value={!!tg.enabled} onChange={(v) => void putSettings({ telegram: { enabled: v } })} />
                    <label className="dock-field">
                        <span>봇 토큰</span>
                        <input type="text" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
                    </label>
                    <label className="dock-field">
                        <span>허용 채팅 ID (쉼표 구분)</span>
                        <input type="text" value={tgChatIds} onChange={(e) => setTgChatIds(e.target.value)} />
                    </label>
                    <div className="dock-row"><button type="button" className="dock-mini-btn" onClick={saveTelegramText}>Telegram 저장</button></div>
                    <TogglePair label="자동 전송" value={tg.forwardAll !== false} onChange={(v) => void putSettings({ telegram: { forwardAll: v } })} />
                    <TogglePair label="Mention Only" value={tg.mentionOnly !== false} onChange={(v) => void putSettings({ telegram: { mentionOnly: v } })} />
                </div>
            )}

            {channel === 'discord' && (
                <div className="dock-channel">
                    <TogglePair label="Discord 활성화" value={!!dc.enabled} onChange={(v) => void putSettings({ discord: { enabled: v } })} />
                    <label className="dock-field">
                        <span>Bot Token</span>
                        <input type="text" value={dcToken} onChange={(e) => setDcToken(e.target.value)} />
                    </label>
                    <label className="dock-field">
                        <span>Guild ID</span>
                        <input type="text" value={dcGuildId} onChange={(e) => setDcGuildId(e.target.value)} />
                    </label>
                    <label className="dock-field">
                        <span>Channel IDs (쉼표 구분)</span>
                        <input type="text" value={dcChannelIds} onChange={(e) => setDcChannelIds(e.target.value)} />
                    </label>
                    <div className="dock-row"><button type="button" className="dock-mini-btn" onClick={saveDiscordText}>Discord 저장</button></div>
                    <TogglePair label="Mention Only" value={!!dc.mentionOnly} onChange={(v) => void putSettings({ discord: { mentionOnly: v } })} />
                    <TogglePair label="자동 전송" value={!!dc.forwardAll} onChange={(v) => void putSettings({ discord: { forwardAll: v } })} />
                    <TogglePair label="Allow Bots" value={!!dc.allowBots} onChange={(v) => void putSettings({ discord: { allowBots: v } })} />
                </div>
            )}

            <div className="dock-section">
                <div className="dock-section-header dock-section-header-static"><span>Fallback</span></div>
                {Array.from({ length: slotCount }, (_, i) => (
                    <label key={i} className="dock-field">
                        <span>Fallback {i + 1}</span>
                        <select
                            value={fallback[i] || ''}
                            onChange={(e) => setFallback((prev) => {
                                const next = [...prev];
                                next[i] = e.target.value;
                                return next;
                            })}
                        >
                            <option value="">—</option>
                            {cliKeys.map((cli) => <option key={cli} value={cli}>{cli}</option>)}
                        </select>
                    </label>
                ))}
                {slotCount > 0 && (
                    <div className="dock-row"><button type="button" className="dock-mini-btn" onClick={saveFallback}>Fallback 저장</button></div>
                )}
            </div>
        </div>
    );
}
