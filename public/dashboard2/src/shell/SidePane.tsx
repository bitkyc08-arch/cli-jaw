import { File, Globe, Plus, Terminal, X } from '@lucide/icons';
import { useState, type JSX } from 'react';
import { Icon } from './Icon.tsx';

type SidePaneTab = 'terminal' | 'browser' | 'files';

interface SidePaneProps {
    onClose(): void;
}

const tabs: Array<{
    id: SidePaneTab;
    label: string;
    icon: typeof Terminal;
    placeholder: string;
}> = [
    { id: 'terminal', label: 'Terminal', icon: Terminal, placeholder: 'Terminal output will appear here' },
    { id: 'browser', label: 'Browser', icon: Globe, placeholder: 'Browser will appear here' },
    { id: 'files', label: 'Files', icon: File, placeholder: 'Files will appear here' },
];

export function SidePane({ onClose }: SidePaneProps): JSX.Element {
    const [activeTab, setActiveTab] = useState<SidePaneTab | null>(null);
    const activeDescriptor = tabs.find((tab) => tab.id === activeTab) ?? null;

    return (
        <aside className="d2-side-pane" aria-label="Side pane">
            <header className="d2-side-pane-header">
                {activeDescriptor ? (
                    <button
                        className="d2-side-pane-pill"
                        type="button"
                        onClick={() => setActiveTab(null)}
                        aria-label="Choose another tab"
                        title="Choose another tab"
                    >
                        <Icon icon={activeDescriptor.icon} size={14} />
                        <span>{activeDescriptor.label}</span>
                    </button>
                ) : null}
                <span className="d2-side-pane-header-spacer" />
                <button
                    className="d2-side-pane-header-button"
                    type="button"
                    onClick={() => setActiveTab(null)}
                    aria-label="Open tab"
                    title="Open tab"
                >
                    <Icon icon={Plus} size={14} />
                </button>
                <button
                    className="d2-side-pane-header-button"
                    type="button"
                    onClick={onClose}
                    aria-label="Close side pane"
                    title="Close side pane"
                >
                    <Icon icon={X} size={14} />
                </button>
            </header>

            <div className="d2-side-pane-body">
                {activeDescriptor ? (
                    <div className="d2-side-pane-placeholder" data-tab={activeDescriptor.id}>
                        <Icon icon={activeDescriptor.icon} size={36} />
                        <span>{activeDescriptor.placeholder}</span>
                    </div>
                ) : (
                    <div className="d2-side-pane-picker">
                        <h2>Open tab</h2>
                        <p>Choose a tab to open in the side pane.</p>
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                className="d2-side-pane-picker-button"
                                type="button"
                                onClick={() => setActiveTab(tab.id)}
                                data-tab={tab.id}
                            >
                                <Icon icon={tab.icon} size={18} />
                                <span>{tab.label}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </aside>
    );
}
