import type { RefObject } from 'react';
import { BackgroundTaskMonitorPanel } from '../background-tasks/BackgroundTaskMonitorPanel';
import { WorkerProgressMonitorPanel } from '../workers/WorkerProgressMonitorPanel';
import type { CodeGitInfo, CodeModelAssignment, CodeModelAssignments, CodeModelOptions, CodeModelPresetInfo } from './code-session-client';
import { CodeCommandPopup } from './CodeCommandPopup';
import { CodeComposer } from './CodeComposer';
import { CodePermissionQueue } from './CodePermissionQueue';
import { CodeTranscript } from './CodeTranscript';
import { CodeWorkspaceHeader } from './CodeWorkspaceHeader';
import { ComposerFooter } from './ComposerFooter';
import type { CodeCommand, CodeCommandPopupKind, PendingPermission, PermissionMode, PermissionOptionKind, TranscriptEntry } from './code-types';

type CodeWorkbenchProps = {
    activePopup: { kind: CodeCommandPopupKind; command: CodeCommand } | null;
    activeSessionId: string | null;
    availableCommands: CodeCommand[];
    codeWorkingDir: string;
    currentEffortOptions: string[];
    currentModelOptions: string[];
    disabled: boolean;
    effort: string;
    gitInfo: CodeGitInfo | null;
    inputText: string;
    messages: TranscriptEntry[];
    model: string;
    modelAssignments: CodeModelAssignments | null;
    modelOptions: CodeModelOptions;
    modelPresets: CodeModelPresetInfo | null;
    permissionMode: PermissionMode;
    permissions: PendingPermission[];
    planEntries: Array<{ title: string; status: string }>;
    popupError: string;
    provider: string;
    providerOptions: string[];
    sending: boolean;
    sessionTitle: string;
    showCommands: boolean;
    transcriptRef: RefObject<HTMLDivElement | null>;
    usage: { contextTokens?: number; contextLimit?: number; cost?: number };
    onClearModelAssignment: (role: CodeModelAssignment['role']) => void | Promise<void>;
    onClosePopup: () => void;
    onCommandSelect: (command: CodeCommand) => void;
    onEffortChange: (value: string) => void;
    onFooterProviderChange: (value: string) => void;
    onInputChange: (text: string) => void;
    onModelChange: (value: string) => void;
    onPermissionAnswer: (permission: PendingPermission, action: PermissionOptionKind) => void;
    onPermissionModeChange: (value: PermissionMode) => void;
    onProviderChange: (value: string) => void;
    onRefreshProviders: () => void;
    onSetDefaultModel: (provider: string, model: string) => void | Promise<void>;
    onSetModelAssignment: (
        role: CodeModelAssignment['role'],
        provider: string,
        model: string,
        thinkingLevel?: string | null,
    ) => void | Promise<void>;
    onShowCommandsChange: (value: boolean) => void;
    onSubmit: () => void;
    onUseModel: (provider: string, model: string) => void | Promise<void>;
    onWorkingDirChange: (path: string | null) => void;
};

export function CodeWorkbench(props: CodeWorkbenchProps) {
    return (
        <div className="code-canvas-main">
            <CodeWorkspaceHeader
                gitInfo={props.gitInfo}
                modelOptions={props.modelOptions}
                sessionTitle={props.sessionTitle}
                usage={props.usage}
                planEntries={props.planEntries}
                workingDir={props.codeWorkingDir}
                cwdLocked={Boolean(props.activeSessionId)}
                onWorkingDirChange={props.onWorkingDirChange}
            />
            <BackgroundTaskMonitorPanel />
            <WorkerProgressMonitorPanel />
            <CodeTranscript messages={props.messages} sending={props.sending} workingDir={props.codeWorkingDir} transcriptRef={props.transcriptRef} />
            <CodePermissionQueue permissions={props.permissions} onAnswer={props.onPermissionAnswer} />
            <div className="code-composer-dock">
                <div className="code-composer-surface" aria-label="Code composer controls">
                    <CodeComposer
                        inputText={props.inputText}
                        sending={props.sending}
                        showCommands={props.showCommands}
                        availableCommands={props.availableCommands}
                        onInputChange={props.onInputChange}
                        onCommandSelect={props.onCommandSelect}
                        onSubmit={props.onSubmit}
                        onShowCommandsChange={props.onShowCommandsChange}
                    />
                    <ComposerFooter
                        provider={props.provider}
                        providerOptions={props.providerOptions}
                        model={props.model}
                        modelOptions={props.currentModelOptions}
                        effort={props.effort}
                        effortOptions={props.currentEffortOptions}
                        permissionMode={props.permissionMode}
                        disabled={props.disabled}
                        onProviderChange={props.onFooterProviderChange}
                        onModelChange={props.onModelChange}
                        onEffortChange={props.onEffortChange}
                        onPermissionModeChange={props.onPermissionModeChange}
                    />
                </div>
            </div>
            {props.activePopup && (
                <CodeCommandPopup
                    popupKind={props.activePopup.kind}
                    command={props.activePopup.command}
                    modelOptions={props.modelOptions}
                    provider={props.provider}
                    model={props.model}
                    modelAssignments={props.modelAssignments}
                    modelPresets={props.modelPresets}
                    permissionMode={props.permissionMode}
                    disabled={props.disabled}
                    activeSessionId={props.activeSessionId}
                    error={props.popupError}
                    onClose={props.onClosePopup}
                    onRefreshProviders={props.onRefreshProviders}
                    onProviderChange={props.onProviderChange}
                    onUseModel={props.onUseModel}
                    onSetDefaultModel={props.onSetDefaultModel}
                    onSetModelAssignment={props.onSetModelAssignment}
                    onClearModelAssignment={props.onClearModelAssignment}
                    onPermissionModeChange={props.onPermissionModeChange}
                />
            )}
        </div>
    );
}
