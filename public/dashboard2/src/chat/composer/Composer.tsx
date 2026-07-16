import { AlertCircle, X } from '@lucide/icons';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ClipboardEvent,
    type DragEvent,
    type JSX,
    type KeyboardEvent,
} from 'react';
import { useManagerApi } from '../../providers/api-provider.tsx';
import { Icon } from '../../shell/Icon.tsx';
import { ComposerFooter, type ComposerPickerDisplay } from './ComposerFooter.tsx';
import { SlashCommandMenu } from './SlashCommandMenu.tsx';
import { filesFromTransfer, intakeAttachments, type ComposerAttachment } from './attachments.ts';
import { AttachmentUploadError, createSendController, type SendSource, type SendSnapshot } from './send-controller.ts';
import {
    applySlashCommand,
    filterSlashCommands,
    moveMenuIndex,
    slashMatch,
    type SlashCommand,
} from './slash-model.ts';
import { useVoiceRecorder } from './useVoiceRecorder.ts';
import './composer.css';

export interface ComposerMention {
    id: string;
    label: string;
}

export interface ComposerEcho {
    id: string;
    source: SendSource;
    prompt: string;
    status: 'sending' | 'sent' | 'error';
    error?: string;
}

export interface ComposerRegistration { submitMessage(prompt: string): Promise<void> }
interface ComposerProps {
    port: number;
    initialDraft?: string;
    commands?: readonly SlashCommand[];
    commandError?: string | null;
    mentions?: readonly ComposerMention[];
    picker?: ComposerPickerDisplay;
    goalLabel?: string | null;
    phase?: string | null;
    isRunning?: boolean;
    onStop?(): void;
    onDraftChange?(draft: string): void;
    onEcho?(echo: ComposerEcho): void;
    onRegister?(registration: ComposerRegistration | null): void;
}

function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
    const match = value.slice(0, caret).match(/(?:^|\s)@([\w.-]*)$/);
    if (!match || match.index === undefined) return null;
    const at = match.index + match[0].indexOf('@');
    return { start: at, query: match[1]!.toLowerCase() };
}

export function Composer({
    port, initialDraft = '', commands = [], commandError = null, mentions = [], picker,
    goalLabel, phase, isRunning, onStop, onDraftChange, onEcho, onRegister,
}: ComposerProps): JSX.Element {
    const api = useManagerApi();
    const [draft, setDraft] = useState(initialDraft);
    const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
    const [sendError, setSendError] = useState<string | null>(null);
    const [isSending, setIsSending] = useState(false);
    const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);
    const [caret, setCaret] = useState(initialDraft.length);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const resizeFrameRef = useRef<number | null>(null);

    const client = useMemo(() => api.instance(port), [api, port]);
    const controller = useMemo(() => client ? createSendController(client) : null, [client]);
    useEffect(() => () => controller?.abort(), [controller]);
    useEffect(() => {
        setAttachments([]);
        setSendError(null);
        // scope switch resets any stuck in-flight state (blob/recorder cleanup
        // happens in their own effects); footer controls must re-enable.
        setIsSending(false);
    }, [port]);

    const setControlledDraft = useCallback((next: string) => {
        setDraft(next);
        onDraftChange?.(next);
    }, [onDraftChange]);

    const slash = slashMatch(draft, caret);
    const matchingCommands = filterSlashCommands(commands, slash);
    const mention = mentionQuery(draft, caret);
    const matchingMentions = mention
        ? mentions.filter(item => item.label.toLowerCase().includes(mention.query)).slice(0, 8)
        : [];

    useEffect(() => setSlashIndex(0), [slash?.query]);
    useEffect(() => {
        if (!inputRef.current) return;
        if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = requestAnimationFrame(() => {
            const input = inputRef.current;
            if (!input) return;
            input.style.height = '0px';
            input.style.height = `${Math.min(180, Math.max(42, input.scrollHeight))}px`;
        });
        return () => {
            if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
        };
    }, [draft]);

    const addFiles = useCallback((files: Iterable<File> | ArrayLike<File>) => {
        setAttachments(current => {
            const result = intakeAttachments(current, files);
            setDuplicateNotice(result.duplicateCount ? `${result.duplicateCount} duplicate file skipped` : null);
            return result.items;
        });
    }, []);

    const performSend = useCallback(async (source: SendSource, overrideDraft?: string) => {
        if (!controller || controller.isInFlight()) return;
        const snapshot: SendSnapshot = { draft: overrideDraft ?? draft, attachments, source };
        if (!snapshot.draft.trim() && !attachments.some(item => item.status !== 'error')) return;
        const echoId = `composer-echo-${Date.now().toString(36)}`;
        setIsSending(true);
        setControlledDraft('');
        setAttachments([]);
        setSendError(null);
        onEcho?.({ id: echoId, source, prompt: snapshot.draft, status: 'sending' });
        try {
            const result = await controller.send(snapshot);
            onEcho?.({ id: echoId, source, prompt: result.prompt, status: 'sent' });
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : 'Send failed';
            setDraft(currentDraft => {
                const restored = currentDraft || snapshot.draft;
                onDraftChange?.(restored);
                return restored;
            });
            setAttachments(current => current.length ? current : snapshot.attachments.map(item => (
                cause instanceof AttachmentUploadError && item.identity === cause.identity
                    ? { ...item, status: 'error', error: message }
                    : item
            )));
            setSendError(message);
            onEcho?.({ id: echoId, source, prompt: snapshot.draft, status: 'error', error: message });
        } finally {
            setIsSending(false);
        }
    }, [attachments, controller, draft, onDraftChange, onEcho, setControlledDraft]);
    useEffect(() => {
        if (!onRegister) return;
        onRegister({ submitMessage: (prompt) => performSend('command', prompt) });
        return () => onRegister(null);
    }, [onRegister, performSend]);

    const applyCommand = useCallback((command: SlashCommand) => {
        if (!slash) return;
        const next = applySlashCommand(draft, command, slash);
        setControlledDraft(next);
        setCaret(next.length);
        if (!command.args) void performSend('command', next);
        else requestAnimationFrame(() => inputRef.current?.focus());
    }, [draft, performSend, setControlledDraft, slash]);

    const applyMention = useCallback((item: ComposerMention) => {
        if (!mention) return;
        const token = `@${item.label}`;
        const next = `${draft.slice(0, mention.start)}${token} ${draft.slice(caret)}`;
        setControlledDraft(next);
        setCaret(mention.start + token.length + 1);
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [caret, draft, mention, setControlledDraft]);

    const voice = useVoiceRecorder({
        client,
        onTranscript: useCallback((text: string) => {
            setControlledDraft([draft.trim(), text].filter(Boolean).join(' '));
        }, [draft, setControlledDraft]),
    });

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (slash && matchingCommands.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashIndex(index => moveMenuIndex(index, event.key === 'ArrowDown' ? 1 : -1, matchingCommands.length));
                return;
            }
            if ((event.key === 'Tab' || event.key === 'Enter') && !event.nativeEvent.isComposing) {
                event.preventDefault();
                applyCommand(matchingCommands[Math.max(0, slashIndex)]!);
                return;
            }
            if (event.key === 'Escape') {
                setCaret(0);
                return;
            }
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void performSend('enter');
        }
    };

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = filesFromTransfer(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        addFiles(files);
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        addFiles(filesFromTransfer(event.dataTransfer));
    };

    return (
        <div className="d2-composer-wrap" onDragOver={event => event.preventDefault()} onDrop={onDrop} data-testid="dashboard2-composer">
            {slash ? <SlashCommandMenu commands={matchingCommands} activeIndex={slashIndex} error={commandError} onSelect={applyCommand} /> : null}
            {mention && matchingMentions.length ? (
                <div className="d2-composer-menu" role="listbox" aria-label="Mentions">
                    {matchingMentions.map(item => (
                        <button key={item.id} type="button" role="option" aria-selected="false" onMouseDown={event => event.preventDefault()} onClick={() => applyMention(item)}>
                            <strong>@{item.label}</strong><span>Display mention</span>
                        </button>
                    ))}
                </div>
            ) : null}
            <div className="d2-composer-pill" data-phase={phase && phase !== 'IDLE' ? phase : undefined}>
                {attachments.length ? (
                    <div className="d2-composer-attachments" aria-label="Attachments">
                        {attachments.map(item => (
                            <span key={item.id} className={item.error ? 'd2-attachment is-error' : 'd2-attachment'} title={item.error || item.file.name}>
                                {item.error ? <Icon icon={AlertCircle} size={14} /> : null}
                                <span>{item.file.name}</span>
                                <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => setAttachments(current => current.filter(entry => entry.id !== item.id))}><Icon icon={X} size={13} /></button>
                            </span>
                        ))}
                    </div>
                ) : null}
                <textarea
                    ref={inputRef}
                    value={draft}
                    rows={1}
                    aria-label="Message"
                    placeholder="Message cli-jaw"
                    onChange={event => {
                        setControlledDraft(event.target.value);
                        setCaret(event.target.selectionStart);
                    }}
                    onSelect={event => setCaret(event.currentTarget.selectionStart)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                />
                {(sendError || voice.error || duplicateNotice) ? (
                    <div className="d2-composer-notice" role="status">
                        {sendError || voice.error || duplicateNotice}
                        {voice.error ? <button type="button" onClick={voice.reset}>Dismiss</button> : null}
                    </div>
                ) : null}
                <ComposerFooter
                    goalLabel={goalLabel ?? null}
                    phase={phase ?? null}
                    disabled={isSending}
                    canSend={Boolean(draft.trim() || attachments.some(item => item.status !== 'error'))}
                    isRunning={Boolean(isRunning)}
                    voiceState={voice.state}
                    onAttach={() => fileRef.current?.click()}
                    onVoice={() => voice.state === 'recording' ? void voice.stop() : void voice.start()}
                    onSend={() => void performSend('button')}
                    {...(picker ? { picker } : {})}
                    {...(onStop ? { onStop } : {})}
                />
                <input ref={fileRef} type="file" multiple hidden onChange={event => { addFiles(event.target.files ?? []); event.target.value = ''; }} />
            </div>
        </div>
    );
}
