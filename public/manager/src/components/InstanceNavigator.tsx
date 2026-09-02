import { useEffect, type ReactNode } from 'react';
import type { DashboardInstance } from '../types';
import {
    INSTANCE_JUMP_HINT_SHOW_DELAY_MS,
    createJumpHintVisibilityController,
    handleInstanceListKeyDown,
    setJumpHintsVisible,
    shouldArmJumpHint,
} from './sidebar-keyboard';

type InstanceNavigatorProps = {
    active: DashboardInstance | null;
    hiddenCount: number;
    collapsed: boolean;
    children: ReactNode;
    query: string;
    onQueryChange: (value: string) => void;
    onSelectPort: (port: number) => void;
};

export function InstanceNavigator(props: InstanceNavigatorProps) {
    useEffect(() => {
        const controller = createJumpHintVisibilityController({
            delayMs: INSTANCE_JUMP_HINT_SHOW_DELAY_MS,
            onVisibilityChange: setJumpHintsVisible,
        });
        const onKeyDown = (event: KeyboardEvent) => {
            controller.sync(shouldArmJumpHint(event));
        };
        const onKeyUp = (event: KeyboardEvent) => {
            controller.sync(shouldArmJumpHint(event));
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            controller.dispose();
            setJumpHintsVisible(false);
        };
    }, []);

    if (props.collapsed) {
        return <div className="instance-navigator is-collapsed">{props.children}</div>;
    }

    return (
        <section className="instance-navigator" aria-label="Instance navigator">
            <header className="instance-navigator-header">
                <div>
                    <p className="eyebrow">Navigator</p>
                    <strong>{props.active ? `:${props.active.port}` : 'No active target'}</strong>
                </div>
                <span>{props.hiddenCount} hidden</span>
                <label className="instance-navigator-search">
                    <span className="visually-hidden">Search instances</span>
                    <input
                        id="manager-sidebar-search"
                        value={props.query}
                        placeholder="Search instances"
                        aria-label="Search instances"
                        onChange={event => props.onQueryChange(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                props.onQueryChange('');
                            }
                        }}
                    />
                </label>
            </header>
            <div
                className="instance-navigator-scroll"
                onKeyDown={event => handleInstanceListKeyDown(event.nativeEvent, event.currentTarget, props.onSelectPort)}
            >
                {props.children}
            </div>
        </section>
    );
}
