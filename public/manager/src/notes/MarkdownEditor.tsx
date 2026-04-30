import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

type MarkdownEditorProps = {
    content: string;
    wordWrap: boolean;
    onChange: (value: string) => void;
};

export function MarkdownEditor(props: MarkdownEditorProps) {
    return (
        <div className={`notes-editor${props.wordWrap ? ' is-word-wrapped' : ''}`}>
            <CodeMirror
                value={props.content}
                extensions={[markdown({ codeLanguages: languages })]}
                onChange={props.onChange}
                height="100%"
                basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                }}
            />
        </div>
    );
}
