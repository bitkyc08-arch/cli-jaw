// 074 — Settings central workspace (replaces chat area when active)
import { ArrowLeft, Moon, Sun } from '@lucide/icons';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useAppScope } from '../../state/scope.tsx';
import { Icon } from '../../shell/Icon.tsx';
import './settings.css';

type SettingsSection = 'general' | 'appearance' | 'about';

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'about', label: 'About' },
];

interface ServerInfo {
    version: string;
    port: string;
    dataDir: string;
    nodeVersion: string;
}

const EMPTY_INFO: ServerInfo = { version: '...', port: '...', dataDir: '...', nodeVersion: '...' };

export function SettingsWorkspace(): JSX.Element {
    const { setWorkspaceMode } = useAppScope();
    const [section, setSection] = useState<SettingsSection>('general');
    const [serverInfo, setServerInfo] = useState<ServerInfo>(EMPTY_INFO);
    const [loadError, setLoadError] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [theme, setTheme] = useState<'dark' | 'light'>(() =>
        document.documentElement.style.colorScheme === 'light' ? 'light' : 'dark',
    );

    // Focus the container on mount for keyboard accessibility
    useEffect(() => { containerRef.current?.focus(); }, []);

    useEffect(() => {
        let cancelled = false;
        // Use the manager status endpoint directly
        fetch('/api/dashboard/status')
            .then(async (res) => {
                if (cancelled) return;
                if (!res.ok) { setLoadError(true); return; }
                const data = await res.json() as Record<string, unknown>;
                if (cancelled) return;
                setServerInfo({
                    version: String(data['version'] ?? ''),
                    port: String(data['port'] ?? ''),
                    dataDir: String(data['dataDir'] ?? data['home'] ?? ''),
                    nodeVersion: String(data['nodeVersion'] ?? ''),
                });
            })
            .catch(() => {
                if (!cancelled) setLoadError(true);
            });
        return () => { cancelled = true; };
    }, []);

    const toggleTheme = (): void => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        document.documentElement.style.colorScheme = next;
        document.documentElement.setAttribute('data-theme', next);
    };

    return (
        <div className="d2-settings-workspace" ref={containerRef} tabIndex={-1}>
            <aside className="d2-settings-nav">
                <button
                    className="d2-settings-back"
                    type="button"
                    onClick={() => setWorkspaceMode('chat')}
                    title="Back to chat"
                >
                    <Icon icon={ArrowLeft} size={16} />
                    <span>Back</span>
                </button>
                <div className="d2-settings-nav-list">
                    {SECTIONS.map((s) => (
                        <button
                            key={s.id}
                            className={`d2-settings-nav-item${section === s.id ? ' active' : ''}`}
                            type="button"
                            onClick={() => setSection(s.id)}
                            aria-current={section === s.id ? 'true' : undefined}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </aside>

            <div className="d2-settings-content">
                {section === 'general' && (
                    <div className="d2-settings-section">
                        <h2>General</h2>
                        {loadError ? (
                            <p className="d2-settings-error-text">Could not load server info.</p>
                        ) : (
                        <div className="d2-settings-group">
                            <div className="d2-settings-row">
                                <span className="d2-settings-label">Version</span>
                                <span className="d2-settings-value">{serverInfo.version || '...'}</span>
                            </div>
                            <div className="d2-settings-row">
                                <span className="d2-settings-label">Port</span>
                                <span className="d2-settings-value">{serverInfo.port || '...'}</span>
                            </div>
                            <div className="d2-settings-row">
                                <span className="d2-settings-label">Data directory</span>
                                <span className="d2-settings-value d2-settings-mono">{serverInfo.dataDir || '...'}</span>
                            </div>
                            <div className="d2-settings-row">
                                <span className="d2-settings-label">Node</span>
                                <span className="d2-settings-value">{serverInfo.nodeVersion || '...'}</span>
                            </div>
                        </div>
                        )}
                    </div>
                )}

                {section === 'appearance' && (
                    <div className="d2-settings-section">
                        <h2>Appearance</h2>
                        <div className="d2-settings-group">
                            <div className="d2-settings-row d2-settings-row-action">
                                <span className="d2-settings-label">Theme</span>
                                <button className="d2-settings-toggle" type="button" onClick={toggleTheme}>
                                    <Icon icon={theme === 'dark' ? Moon : Sun} size={14} />
                                    <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {section === 'about' && (
                    <div className="d2-settings-section">
                        <h2>About</h2>
                        <div className="d2-settings-group">
                            <p className="d2-settings-about-text">
                                cli-jaw is an AI agent orchestration platform.
                            </p>
                            <div className="d2-settings-row">
                                <span className="d2-settings-label">Version</span>
                                <span className="d2-settings-value">{serverInfo.version || '...'}</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
