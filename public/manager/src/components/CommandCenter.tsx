import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { ThemeSwitch } from './ThemeSwitch';
import { isElectron } from '../panels/desktop-bridge';

type CommandCenterProps = {
    title: ReactNode;
    search: ReactNode;
    actions: ReactNode;
    mobileMenuButton: ReactNode;
};

export function CommandCenter(props: CommandCenterProps) {
    const electron = isElectron();
    // Keep the command-bar slot adjacent to the theme control without moving
    // instance navigation state out of its existing owner.
    const actions = isValidElement<{ children?: ReactNode }>(props.actions)
        ? cloneElement(props.actions, {}, Children.toArray(props.actions.props.children).flatMap<ReactNode>(child =>
            isValidElement(child) && child.type === ThemeSwitch ? [<span key="settings" id="command-settings-slot" />, child] : [child]))
        : props.actions;
    return (
        <div className={`command-center command-bar${electron ? ' is-electron-titlebar' : ''}`}>
            <div className="command-primary">
                {props.mobileMenuButton}
                <div className="command-title">{props.title}</div>
                <div className="command-search">{props.search}</div>
                <div className="command-actions">{actions}</div>
            </div>
        </div>
    );
}
