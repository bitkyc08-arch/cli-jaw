import { useRef, useState, type KeyboardEvent } from 'react';

type CodeComposerProps = {
    inputText: string;
    canSend: boolean;
    busy: boolean;
    canStop: boolean;
    stopping: boolean;
    pending: boolean;
    readOnly: boolean;
    onInputChange: (text: string) => void;
    onSubmit: () => Promise<void>;
    onStop: () => Promise<void>;
};

export function CodeComposer(props: CodeComposerProps) {
    const composing = useRef(false);
    const sending = useRef(false);
    const cancelling = useRef(false);
    const [error, setError] = useState<string | null>(null);
    async function submit() {
        if (!props.canSend || !props.inputText.trim() || sending.current) return;
        sending.current = true;
        setError(null);
        try { await props.onSubmit(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { sending.current = false; }
    }
    async function stop() {
        if (!props.canStop || cancelling.current) return;
        cancelling.current = true;
        setError(null);
        try { await props.onStop(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { cancelling.current = false; }
    }
    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            void submit();
        }
    }
    return <div className="code-composer">
        <div className="code-composer-input-shell">
            <textarea className="code-composer-input" aria-label="Code prompt" value={props.inputText}
                onChange={event => props.onInputChange(event.target.value)} onKeyDown={handleKeyDown}
                onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
                placeholder={props.busy ? 'Draft a follow-up while this turn runs…' : 'Describe a task or ask a question…'}
                rows={2} readOnly={props.readOnly} />
            <span className="code-composer-hint">Enter to send · Shift+Enter for a new line</span>
        </div>
        {props.busy ? <button type="button" className="code-composer-send code-composer-stop" aria-label="Stop current turn"
            disabled={!props.canStop || props.stopping} onClick={() => void stop()}>{props.stopping ? 'Stopping…' : 'Stop'}</button>
            : <button type="button" className="code-composer-send" aria-label="Send prompt"
                disabled={!props.canSend || !props.inputText.trim()} onClick={() => void submit()}>{props.pending ? 'Sending…' : 'Send'}</button>}
        {error && <div className="code-action-error" role="alert">{error}</div>}
    </div>;
}
