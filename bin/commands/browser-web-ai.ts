import { parseArgs } from 'node:util';
import { renderContextDryRunReport } from '../../src/browser/web-ai/context-pack/index.js';
import type { ContextDryRunMode, ContextPackResult } from '../../src/browser/web-ai/context-pack/index.js';

type BrowserApi = (method: string, path: string, body?: unknown) => Promise<unknown>;
type QueryString = (params: Record<string, unknown>) => string;

const WEB_AI_COMMANDS = new Set(['render', 'status', 'send', 'poll', 'query', 'watch', 'watchers', 'sessions', 'sessions-prune', 'resume', 'reattach', 'notifications', 'capabilities', 'stop', 'diagnose', 'doctor', 'context-dry-run', 'context-render', 'code', 'code-extract']);

function parseContextDryRunMode(value: unknown): ContextDryRunMode {
    return value === 'json' || value === 'full' || value === 'summary' ? value : 'summary';
}

export const WEB_AI_USAGE = `
Usage:
  cli-jaw browser web-ai <command> --vendor <chatgpt|gemini|grok> [options]

Commands:
  render              Render the prompt envelope without opening a browser
  status              Check verified provider tab state
  send                Send a prompt and store a durable session
  poll                Poll a session for completion
  query               send + poll in one command
  watch               Watch a saved session until terminal status
  watchers            List active web-ai watchers
  sessions            List saved web-ai sessions
  notifications       List web-ai completion notifications
  capabilities        List observed/provider capability schemas
  diagnose | doctor   Capture redacted diagnostics for the active provider page
  stop                Stop current provider generation with Escape
  context-dry-run     Build a context package without sending
  context-render      Render full prompt/context package text
  code                ChatGPT-only code generation. Automatically uploads the
                      saved GPT dev-agent context zip first, requires PLAN.md
                      or 00_plan.md in new artifacts, and retrieves zip output.
  code-extract        Re-retrieve existing ChatGPT code-mode zip artifacts
                      from a conversation without sending a new prompt.

Provider:
  --vendor <name>     chatgpt | gemini | grok (default: chatgpt)
  --model <alias>     ChatGPT: instant, thinking, pro
                      Gemini:  flash-lite, flash, pro, deepthink
                      Grok:    auto, fast, expert, thinking, heavy
  --effort <alias>    ChatGPT reasoning effort. Requires --model because
                      ChatGPT may expose either legacy effort menus or the
                      simplified Intelligence picker.
                      Pro: standard, extended
                      Thinking: light, standard, extended, heavy
                      Intelligence mapping: thinking/light -> Instant,
                      thinking/standard -> Medium, thinking/extended -> High,
                      thinking/heavy -> Extra High, pro/standard -> Pro Extended,
                      pro/extended -> Pro Extended.
  --reasoning-effort <alias>
                      Alias for --effort
  --timeout <sec>     Polling timeout

Prompt and context:
  --prompt <text>     Main prompt/question
  --inline-only       Required for send/query without files
  --file <path>       Upload a file; repeatable for mixed files
  --context-from-files <glob|path>
  --context-exclude <glob>
  --context-file <path>
  --context-transport <upload|inline>
  --allow-copy-markdown-fallback
                      Explicitly permit provider Copy button capture; no OS clipboard read
  --allow-grok-context-pack
  --require-source-audit
                      Fail closed when completed answers lack inline sources
  --source-audit-ratio <0..1>
                      Required sourced claim ratio (default: 1)
  --source-audit-scope <text>
                      Checked scope for absence/no-result claims
  --source-audit-date <text>
                      Checked date for absence/no-result claims

ChatGPT tools & modes:
  --tool <name>       Select a ChatGPT composer tool; repeatable.
                      Values: image, deep-research, web-search, agent-mode, tasks
                      Plugins: canva, figma, github, gmail, supabase, etc.
  --auto-tools        Heuristically select tools from prompt content
  --research deep     Activate ChatGPT Deep Research mode
  --follow-up <text>  Send follow-up prompts into existing conversation; repeatable

Sessions:
  --session <id>      Resume/poll a saved session
  --deadline <iso>    Override session deadline
  --navigate          Allow resume to switch tabs if needed
  --new-tab           Force a fresh provider tab; default reuses pooled or inactive tabs first
  --parallel          Alias for --new-tab. Use to run a query without
                      contending with another in-flight one (lease per-key cap)
  --reuse-tab         Reuse active tab

Output:
  --json              Print JSON
  --full              Print full context dry-run/render output

Code artifacts:
  --output-zip <path> Save a single code artifact zip
  --multi-zip        Retrieve several named /mnt/data/*.zip artifacts
  --output-dir <dir> Save multi-zip artifacts into this directory
  --conversation <id|url>
                      Existing ChatGPT conversation for code-extract

Examples:
  cli-jaw browser web-ai render --vendor chatgpt --prompt "hello" --json
  cli-jaw browser web-ai query --vendor chatgpt --model pro --effort extended --inline-only --prompt "Reply OK"
  cli-jaw browser web-ai code --vendor chatgpt --model thinking --effort standard --prompt "Build an MVP" --output-zip ./result.zip
  cli-jaw browser web-ai code-extract --vendor chatgpt --conversation "https://chatgpt.com/c/<conversation-id>" --output-zip ./result.zip
  cli-jaw browser web-ai query --vendor grok --inline-only --prompt "Reply OK"
`;

export const WEB_AI_CODE_USAGE = `
Usage:
  cli-jaw browser web-ai code --vendor chatgpt --prompt <build-spec> [options]

What it does:
  ChatGPT-only code generation through the browser web-ai runtime. This is a
  subcommand, not a --code flag. It automatically uploads the saved GPT
  dev-agent context zip first, sends a strict code-mode contract prompt, waits
  for ChatGPT to create /mnt/data/*.zip in its sandbox, retrieves the archive,
  verifies it, and writes it locally.

Required:
  --prompt <text>       Build spec for ChatGPT.

Recommended model:
  --model thinking
  --effort <alias>      thinking: light|standard|extended|heavy
                        pro: standard|extended

Artifact options:
  --output-zip <path>   Save one generated zip to this path.
  --multi-zip           Retrieve several named /mnt/data/*.zip artifacts.
  --output-dir <dir>    Save multi-zip artifacts into this directory.

Optional inputs:
  --file <path>         Repeatable upload; may mix zip, image, PDF, docs, text.
  --context-from-files <glob|path>
  --context-exclude <glob>
  --context-file <path>
  --context-transport <upload|inline>

Behavior:
  New code artifacts must include PLAN.md or 00_plan.md at the zip root.
  A visible turn_plan.update_turn_plan checklist is best-effort and may be
  transient; the plan file inside the zip is the durable checklist.

Examples:
  cli-jaw browser web-ai code --vendor chatgpt --model thinking --effort standard \\
          --prompt "Create a Flask hello-world MVP." \\
          --output-zip ./result.zip

  cli-jaw browser web-ai code --vendor chatgpt --model thinking --effort heavy \\
          --multi-zip --output-dir ./artifacts \\
          --prompt "Create backend.zip and frontend.zip as separate deliverables."
`;

export const WEB_AI_CODE_EXTRACT_USAGE = `
Usage:
  cli-jaw browser web-ai code-extract --vendor chatgpt [conversation selector] [options]

What it does:
  ChatGPT-only artifact re-extraction. It does not send a new prompt. It scans
  the saved ChatGPT conversation for /mnt/data/*.zip paths, reuses the provider
  download flow, validates the zip, and writes it locally.

Conversation selector:
  --url <chatgpt conversation URL>
  --conversation <id|url>
  --session <sessionId>
  Or omit these when the target ChatGPT conversation tab is already open.

Artifact options:
  --output-zip <path>   Save one recovered zip to this path.
  --multi-zip           Recover every mentioned /mnt/data/*.zip artifact.
  --output-dir <dir>    Save multi-zip artifacts into this directory.

Requirements:
  The original conversation must still be accessible in the logged-in ChatGPT
  browser profile. A copied /mnt/data/result.zip text line alone is not enough.

Examples:
  cli-jaw browser web-ai code-extract --vendor chatgpt \\
          --conversation "https://chatgpt.com/c/<conversation-id>" \\
          --output-zip ./result.zip

  cli-jaw browser web-ai code-extract --vendor chatgpt \\
          --conversation "https://chatgpt.com/c/<conversation-id>" \\
          --multi-zip --output-dir ./artifacts
`;

function usageForCommand(command: string | undefined): string {
    if (command === 'code') return WEB_AI_CODE_USAGE.trim();
    if (command === 'code-extract') return WEB_AI_CODE_EXTRACT_USAGE.trim();
    return WEB_AI_USAGE.trim();
}

function rejectFutureWebAiFlags(values: Record<string, unknown>): void {
    const vendor = values["vendor"] ?? 'chatgpt';
    if (vendor !== 'chatgpt' && vendor !== 'gemini' && vendor !== 'grok') throw new Error(`unsupported vendor: ${vendor}`);
    if (values["model"] && !isSupportedWebAiModel(vendor, values["model"])) throw new Error(`unsupported ${webAiVendorLabel(vendor)} model selection: ${values["model"]}`);
    const effort = values["effort"] || values['reasoning-effort'];
    if (effort && !values["model"]) throw new Error(`${webAiVendorLabel(vendor)} reasoning effort requires --model because effort menus differ by model`);
    if (effort && !isSupportedWebAiEffort(vendor, values["model"], effort)) throw new Error(`unsupported ${webAiVendorLabel(vendor)} reasoning effort: ${effort}`);
}

function isSupportedWebAiModel(vendor: unknown, model: unknown): boolean {
    const key = String(model || '').trim().toLowerCase();
    if (String(vendor || 'chatgpt') === 'gemini' && /^(?:gemini\s+)?(?:\d+(?:\.\d+)?\s+)?(?:flash[-_\s]?lite|flash|pro)$/.test(key)) return true;
    const byVendor: Record<string, Set<string>> = {
        chatgpt: new Set(['instant', 'fast', 'gpt-5-3', 'gpt-5.3', 'thinking', 'think', 'gpt-5-5-thinking', 'gpt-5.5-thinking', 'pro', 'gpt-5-5-pro', 'gpt-5.5-pro']),
        gemini: new Set(['fast', 'flash-lite', 'flash_lite', 'flash lite', 'gemini-fast', 'gemini-flash-lite', 'gemini-flash_lite', 'gemini flash lite', 'flash', 'gemini-flash', 'thinking', 'think', 'gemini-thinking', 'pro', 'gemini-pro', 'deepthink', 'deep-think', 'deep_think', 'deep think', 'gemini-deepthink', 'gemini-deep-think']),
        grok: new Set(['auto', 'automatic', 'fast', 'quick', 'expert', 'thinking', 'think', 'grok-4.3', 'grok43', 'grok-43', 'beta', 'heavy']),
    };
    return Boolean(byVendor[String(vendor || 'chatgpt')]?.has(key));
}

function isSupportedWebAiEffort(vendor: unknown, model: unknown, effort: unknown): boolean {
    if (String(vendor || 'chatgpt') !== 'chatgpt') return false;
    const effortKey = String(effort || '').trim().toLowerCase();
    const normalizedEffort = ({ low: 'light', light: 'light', standard: 'standard', normal: 'standard', regular: 'standard', default: 'standard', high: 'extended', extended: 'extended', heavy: 'heavy' } as Record<string, string>)[effortKey];
    if (!normalizedEffort) return false;
    const modelKey = String(model || '').trim().toLowerCase();
    const normalizedModel = ({ think: 'thinking', thinking: 'thinking', 'gpt-5-5-thinking': 'thinking', 'gpt-5.5-thinking': 'thinking', pro: 'pro', 'gpt-5-5-pro': 'pro', 'gpt-5.5-pro': 'pro' } as Record<string, string>)[modelKey];
    if (normalizedModel === 'thinking') return ['light', 'standard', 'extended', 'heavy'].includes(normalizedEffort);
    if (normalizedModel === 'pro') return ['standard', 'extended'].includes(normalizedEffort);
    return false;
}

function webAiVendorLabel(vendor: unknown): string {
    const key = String(vendor || 'chatgpt');
    if (key === 'chatgpt') return 'ChatGPT';
    if (key === 'gemini') return 'Gemini';
    if (key === 'grok') return 'Grok';
    return key;
}

export async function runWebAiCommand(
    args: string[],
    deps: { api: BrowserApi; qs: QueryString },
): Promise<void> {
    const command = args[0];
    if (!command || command === '--help' || command === 'help') {
        console.log(WEB_AI_USAGE.trim());
        return;
    }
    if (args.includes('--help')) {
        console.log(usageForCommand(command));
        return;
    }
    if (!command || !WEB_AI_COMMANDS.has(command)) {
        throw new Error(WEB_AI_USAGE.trim());
    }
    const { values } = parseArgs({
        args: args.slice(1),
        options: {
            vendor: { type: 'string', default: 'chatgpt' },
            prompt: { type: 'string' },
            url: { type: 'string' },
            system: { type: 'string' },
            project: { type: 'string' },
            goal: { type: 'string' },
            context: { type: 'string' },
            question: { type: 'string' },
            output: { type: 'string' },
            constraints: { type: 'string' },
            timeout: { type: 'string' },
            session: { type: 'string' },
            stage: { type: 'string' },
            status: { type: 'string' },
            family: { type: 'string' },
            'frontend-status': { type: 'string' },
            'poll-interval': { type: 'string' },
            'inline-only': { type: 'boolean', default: false },
            'allow-copy-markdown-fallback': { type: 'boolean', default: false },
            'allow-grok-context-pack': { type: 'boolean', default: false },
            'require-source-audit': { type: 'boolean', default: false },
            'source-audit-ratio': { type: 'string' },
            'source-audit-scope': { type: 'string' },
            'source-audit-date': { type: 'string' },
            notify: { type: 'boolean', default: true },
            file: { type: 'string', multiple: true },
            'output-zip': { type: 'string' },
            'output-dir': { type: 'string' },
            'multi-zip': { type: 'boolean', default: false },
            'context-refresh': { type: 'boolean', default: false },
            conversation: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            'reasoning-effort': { type: 'string' },
            'thinking-time': { type: 'string' },
            'context-from-files': { type: 'string', multiple: true },
            'context-exclude': { type: 'string', multiple: true },
            'context-file': { type: 'string' },
            'max-input': { type: 'string' },
            'max-file-size': { type: 'string' },
            'files-report': { type: 'boolean', default: false },
            'context-transport': { type: 'string' },
            'dry-run': { type: 'string' },
            'older-than-ms': { type: 'string' },
            before: { type: 'string' },
            probe: { type: 'string' },
            deadline: { type: 'string' },
            navigate: { type: 'boolean', default: false },
            'new-tab': { type: 'boolean', default: false },
            parallel: { type: 'boolean', default: false },
            'reuse-tab': { type: 'boolean', default: false },
            tool: { type: 'string', multiple: true },
            'auto-tools': { type: 'boolean', default: false },
            research: { type: 'string' },
            'follow-up': { type: 'string', multiple: true },
            full: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
        strict: false,
    });
    rejectFutureWebAiFlags(values);
    const hasContextPackage = Boolean(values['context-file'] || (Array.isArray(values['context-from-files']) && values['context-from-files'].length > 0));
    const filePaths = (Array.isArray(values.file) ? values.file : (values.file ? [values.file] : [])).filter((value): value is string => typeof value === 'string');
    if (['send', 'query'].includes(command) && !values['inline-only'] && filePaths.length === 0 && !hasContextPackage) {
        throw new Error('web-ai send/query require --inline-only or --file=<path>');
    }
    const body = {
        vendor: values.vendor,
        url: values.url,
        prompt: values.prompt,
        system: values.system,
        project: values.project,
        goal: values.goal,
        context: values.context,
        question: values.question,
        output: values.output,
        constraints: values.constraints,
        timeout: values.timeout,
        attachmentPolicy: filePaths.length ? 'upload' : 'inline-only',
        ...(filePaths.length ? { filePath: filePaths[0], filePaths } : {}),
        ...(values['output-zip'] ? { outputZip: values['output-zip'] } : {}),
        ...(values['output-dir'] ? { outputDir: values['output-dir'] } : {}),
        ...(values['multi-zip'] ? { multiZip: true } : {}),
        ...(values['context-refresh'] ? { contextRefresh: true } : {}),
        ...(values.conversation ? { conversation: values.conversation } : {}),
        ...(values['thinking-time'] ? { thinkingTime: values['thinking-time'] } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.effort || values['reasoning-effort'] ? { reasoningEffort: values.effort || values['reasoning-effort'] } : {}),
        contextFromFiles: values['context-from-files'] || [],
        contextExclude: values['context-exclude'] || [],
        ...(values['context-file'] ? { contextFile: values['context-file'] } : {}),
        ...(values['max-input'] ? { maxInput: values['max-input'] } : {}),
        ...(values['max-file-size'] ? { maxFileSize: values['max-file-size'] } : {}),
        ...(values['files-report'] ? { filesReport: values['files-report'] } : {}),
        ...(values['context-transport'] ? { contextTransport: values['context-transport'] } : {}),
        ...(values['inline-only'] ? { inlineOnly: true } : {}),
        ...(values['allow-copy-markdown-fallback'] ? { allowCopyMarkdownFallback: true } : {}),
        ...(values['allow-grok-context-pack'] ? { allowGrokContextPack: true } : {}),
        ...(values['require-source-audit'] ? { requireSourceAudit: true } : {}),
        ...(values['source-audit-ratio'] ? { sourceAuditRatio: values['source-audit-ratio'] } : {}),
        ...(values['source-audit-scope'] ? { sourceAuditScope: values['source-audit-scope'] } : {}),
        ...(values['source-audit-date'] ? { sourceAuditDate: values['source-audit-date'] } : {}),
        ...(values['new-tab'] || values.parallel ? { newTab: true } : {}),
        ...(values['reuse-tab'] ? { reuseTab: true } : {}),
        ...(Array.isArray(values.tool) && values.tool.length ? { tools: values.tool } : {}),
        ...(values['auto-tools'] ? { autoTools: true } : {}),
        ...(values.research ? { research: values.research } : {}),
        ...(Array.isArray(values['follow-up']) && values['follow-up'].length ? { followUps: values['follow-up'] } : {}),
    };
    const rawResult = await callWebAiEndpoint(command, body, values, deps);
    const fullContextOutput = values.full === true || command === 'context-render';
    if (isContextCommand(command)) {
        const result = rawResult as ContextPackResult;
        if (values.json) {
            console.log(renderContextDryRunReport(result, {
            mode: 'json',
            full: fullContextOutput,
            json: true,
            includeComposerText: fullContextOutput,
            }));
        } else {
            console.log(renderContextDryRunReport(result, {
            mode: fullContextOutput ? 'full' : parseContextDryRunMode(values['dry-run']),
            full: fullContextOutput,
            }));
        }
    } else if (values.json) console.log(JSON.stringify(rawResult, null, 2));
    else {
        printWebAiHuman(command, rawResult as Record<string, unknown>);
    }
}

async function callWebAiEndpoint(
    command: string,
    body: Record<string, unknown>,
    values: Record<string, unknown>,
    deps: { api: BrowserApi; qs: QueryString },
): Promise<unknown> {
    if (command === 'status') return deps.api('GET', `/web-ai/status${deps.qs({ vendor: values["vendor"], probe: values["probe"] })}`);
    if (command === 'sessions') return deps.api('GET', `/web-ai/sessions${deps.qs({ vendor: values["vendor"], status: values["status"] })}`);
    if (command === 'sessions-prune') {
        const olderThanMs = values['older-than-ms'] ? Number(values['older-than-ms']) : undefined;
        return deps.api('POST', '/web-ai/sessions/prune', {
            ...(olderThanMs !== undefined && Number.isFinite(olderThanMs) ? { olderThanMs } : {}),
            ...(values["before"] ? { before: values["before"] } : {}),
            ...(values["status"] ? { status: values["status"] } : {}),
        });
    }
    if (command === 'notifications') return deps.api('GET', `/web-ai/notifications${deps.qs({ vendor: values["vendor"], status: values["status"], session: values["session"] })}`);
    if (command === 'watchers') return deps.api('GET', '/web-ai/watchers');
    if (command === 'capabilities') return deps.api('GET', `/web-ai/capabilities${deps.qs({ vendor: values["vendor"], family: values["family"], frontendStatus: values['frontend-status'] })}`);
    if (command === 'poll') return deps.api('GET', `/web-ai/poll${deps.qs({ vendor: values["vendor"], timeout: values["timeout"], session: values["session"], allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'], requireSourceAudit: values['require-source-audit'], sourceAuditRatio: values['source-audit-ratio'], sourceAuditScope: values['source-audit-scope'], sourceAuditDate: values['source-audit-date'] })}`);
    if (command === 'watch') return deps.api('GET', `/web-ai/watch${deps.qs({ vendor: values["vendor"], timeout: values["timeout"], session: values["session"], url: values["url"], notify: values["notify"], pollIntervalSeconds: values['poll-interval'], allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'], requireSourceAudit: values['require-source-audit'], sourceAuditRatio: values['source-audit-ratio'], sourceAuditScope: values['source-audit-scope'], sourceAuditDate: values['source-audit-date'] })}`);
    if (command === 'resume') return deps.api('GET', `/web-ai/poll${deps.qs({ vendor: values["vendor"], session: values["session"], timeout: values["timeout"] || values["deadline"], allowCopyMarkdownFallback: values['allow-copy-markdown-fallback'], requireSourceAudit: values['require-source-audit'], sourceAuditRatio: values['source-audit-ratio'], sourceAuditScope: values['source-audit-scope'], sourceAuditDate: values['source-audit-date'] })}`);
    if (command === 'reattach') {
        if (!values["session"]) throw new Error('reattach requires --session <id>');
        return deps.api('GET', `/web-ai/status${deps.qs({ vendor: values["vendor"], session: values["session"], navigate: values["navigate"] })}`);
    }
    if (command === 'doctor' || command === 'diagnose') return deps.api('GET', `/web-ai/diagnose${deps.qs({ vendor: values["vendor"], stage: values["stage"] })}`);
    if (command === 'context-dry-run' || command === 'context-render') return deps.api('POST', `/web-ai/${command}`, body);
    return deps.api('POST', `/web-ai/${command}`, body);
}

function isContextCommand(command: string): boolean {
    return command === 'context-dry-run' || command === 'context-render';
}

function printWebAiHuman(command: string, result: Record<string, unknown>): void {
    if (command === 'render') {
        const rendered = result["rendered"] as { composerText?: string; markdown?: string } | undefined;
        console.log(rendered?.composerText || rendered?.markdown || '');
        if (Array.isArray(result["warnings"]) && result["warnings"].length) console.error(`[warnings] ${result["warnings"].join(', ')}`);
        return;
    }
    if (result["answerText"]) {
        console.log(result["answerText"]);
        return;
    }
    const artifact = result["artifact"] as { savedPath?: string } | undefined;
    if (artifact?.savedPath) {
        console.log(artifact.savedPath);
        return;
    }
    if (result["outputDir"]) {
        console.log(String(result["outputDir"]));
        return;
    }
    for (const key of ['sessions', 'notifications', 'watchers', 'capabilities']) {
        if (Array.isArray(result[key])) {
            console.log(JSON.stringify(result[key], null, 2));
            return;
        }
    }
    console.log(`${result["status"]}: ${result["url"] || result["vendor"] || 'web-ai'}`);
}
