import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), 'utf8');
}

test('code transcript linearizes assistant markdown tables without changing Notes preview defaults', () => {
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    const css = read('public/manager/src/code/code.css');
    const notesPreview = read('public/manager/src/notes/MarkdownPreview.tsx');

    assert.ok(
        transcript.includes('<MarkdownRenderer markdown={msg.text} tableMode="linear" />'),
        'Code assistant transcript must opt into linear markdown tables',
    );
    assert.ok(
        css.includes('.code-message-text .markdown-linear-table'),
        'Code CSS must own linear table transcript styling',
    );
    assert.ok(
        css.includes('.code-message-text .markdown-linear-table-row'),
        'Code CSS must style linear table rows without relying on native table layout',
    );
    assert.ok(
        css.includes('grid-template-columns: var(--markdown-linear-table-grid'),
        'Code linear tables must align header and body cells through one shared grid template',
    );
    assert.ok(
        css.includes('display: contents'),
        'Code linear table wrappers must flatten into the shared grid without native table semantics',
    );
    assert.ok(
        notesPreview.includes('<MarkdownRenderer') && !notesPreview.includes('tableMode='),
        'Notes preview must keep MarkdownRenderer semantic table defaults',
    );
});

test('code transcript virtualizes rows only inside Code mode', () => {
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    const hook = read('public/manager/src/code/useCodeTranscriptVirtualRows.ts');
    const css = read('public/manager/src/code/code.css');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const jawMode = read('public/js/main.ts');

    assert.ok(transcript.includes("import { useCodeTranscriptVirtualRows } from './useCodeTranscriptVirtualRows';"),
        'CodeTranscript must own the Code-only virtual rows hook import');
    assert.ok(transcript.includes('const virtual = useCodeTranscriptVirtualRows({'),
        'CodeTranscript must render through the Code virtual rows hook');
    assert.ok(transcript.includes('code-transcript-virtual-spacer'),
        'CodeTranscript must render a virtual spacer');
    assert.ok(transcript.includes('data-code-transcript-idx={virtualItem.index}'),
        'CodeTranscript virtual rows must expose a stable measure index');
    assert.ok(hook.includes("@tanstack/virtual-core"),
        'Code transcript virtual hook must use the existing TanStack virtual-core dependency');
    assert.ok(hook.includes("indexAttribute: 'data-code-transcript-idx'"),
        'Code transcript virtual hook must measure the Code row index attribute');
    assert.ok(hook.includes('getScrollElement: () => args.scrollElementRef.current'),
        'Code transcript virtual hook must use the existing transcriptRef scroll element');
    assert.ok(css.includes('.code-transcript-virtual-spacer'),
        'Code CSS must own virtual spacer layout');
    assert.ok(css.includes('.code-transcript-virtual-row'),
        'Code CSS must own virtual row positioning');
    assert.ok(workbench.includes('<CodeTranscript'),
        'CodeTranscript must stay mounted through the Code workbench boundary');
    assert.equal(jawMode.includes('useCodeTranscriptVirtualRows'), false,
        'Jaw mode public/js entry must not import Code transcript virtualization');
});

test('code session stored rows use JWC title and first-message fallback instead of cwd primary fallback', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('storedSessionTitle'), 'CodeSessionList must centralize stored title fallback');
    assert.ok(list.includes("session.title?.trim()"), 'stored title must prefer JWC title');
    assert.ok(list.includes("session.firstMessage?.replace"), 'stored title must fall back to first user message when available');
    assert.ok(list.includes("session.sessionId.slice"), 'stored title must use a stable session id prefix after title/firstMessage');
    assert.equal(list.includes('s.title || cwdLabel(s.cwd)'), false, 'stored session primary title must not fall back to cwd basename');
    assert.ok(list.includes('storedSessionMeta'), 'cwd should move to secondary metadata');
});

test('code session live rows do not use cwd basename as primary title', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('liveSessionTitle'), 'CodeSessionList must centralize live title fallback');
    assert.ok(list.includes("session.title?.trim()"), 'live title must prefer returned JWC title when available');
    assert.ok(list.includes('firstReplayUserLine(session)'), 'live title must fall back to the replayed first user line before ids');
    assert.ok(list.includes('|| cwdLabel(session.cwd)'), 'live title may fall back to cwd basename before the final id fallback');
    assert.ok(list.includes("session.sessionId.slice(0, 12)"), 'live title must keep stable session id prefix as the last fallback');
    assert.ok(list.includes('liveSessionMeta'), 'live cwd should render as secondary metadata');
    assert.equal(list.includes('<span className="code-session-cwd">{cwdLabel(s.cwd)}</span>'), false, 'live session primary title must not be cwd basename');
});

test('code session list searches title firstMessage cwd and session id, then sorts before limit', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('storedSessionSearchText'), 'stored session search helper must exist');
    for (const token of ['session.sessionId', "session.title ?? ''", "session.firstMessage ?? ''", 'session.cwd']) {
        assert.ok(list.includes(token), `search helper must include ${token}`);
    }
    const sortIndex = list.indexOf('.sort((left, right) => storedSessionTime(right) - storedSessionTime(left))');
    const sliceIndex = list.indexOf('.slice(0, 20)');
    assert.ok(sortIndex > 0, 'stored sessions must sort by timestamp');
    assert.ok(sliceIndex > sortIndex, 'stored sessions must sort before applying visible limit');
    assert.ok(list.includes('Date.parse(session.updatedAt)'), 'stored timestamp must parse ACP updatedAt');
});

test('code session list defaults to global JWC catalog and exposes explicit cwd grouping controls', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');
    const client = read('public/manager/src/code/code-session-client.ts');
    const host = read('src/code-mode/acp-host.ts');
    const types = read('src/code-mode/types.ts');
    const routes = read('src/routes/code.ts');

    assert.ok(list.includes("type SessionViewMode = 'all' | 'cwd' | 'grouped'"), 'session list must model all/cwd/grouped modes');
    assert.ok(list.includes("useState<SessionViewMode>('all')"), 'session list must default to all JWC sessions');
    assert.ok(list.includes("client.listStoredSessions(storedOptions)"), 'session list must use explicit stored session options');
    assert.ok(list.includes("scope: 'cwd' as const, cwd: workingDir"), 'cwd mode must request cwd-scoped sessions explicitly');
    assert.ok(list.includes("scope: 'all' as const"), 'all/grouped modes must request the global JWC catalog');
    assert.ok(list.includes('Promise.allSettled'), 'session list must not collapse partial live/history load failures into a fake empty state');
    assert.ok(list.includes('const [loadError, setLoadError]'), 'session list must keep visible load error state');
    assert.ok(list.includes('code-session-list-error'), 'session list must render load errors in the sidebar');
    assert.ok(list.includes('Session data could not fully load.'), 'empty state must distinguish load failure from real empty history');
    for (const label of ['All', 'This cwd', 'Group']) {
        assert.ok(list.includes(`>${label}</button>`), `session list must expose ${label} control`);
    }
    assert.ok(list.includes('groupedStoredSessions'), 'session list must group global history by cwd locally');
    assert.ok(list.includes('No sessions for this cwd. Switch to All to browse global history.'), 'cwd empty state must explain the filter');
    assert.ok(list.includes('No JWC sessions found.'), 'global empty state must not imply current cwd filtering');

    assert.ok(client.includes("listStoredSessions(options?: { cwd?: string; scope?: 'all' | 'cwd' })"), 'client interface must expose explicit list options');
    assert.ok(client.includes("const scope = options.scope ?? 'all'"), 'client must default stored session requests to all');
    assert.ok(client.includes("new URLSearchParams({ scope })"), 'client must serialize scope query');

    assert.ok(types.includes("listStoredSessions(options?: { cwd?: string; scope?: 'all' | 'cwd' })"), 'transport type must expose explicit stored session options');
    assert.ok(host.includes("async listStoredSessions(options: { cwd?: string; scope?: 'all' | 'cwd' } = {})"), 'ACP host must implement explicit stored session options');
    assert.ok(host.includes("const scope = options.scope ?? (options.cwd ? 'cwd' : 'all')"), 'ACP host must preserve cwd fallback while supporting global scope');
    assert.ok(host.includes("const sessions = await this.listStoredSessions({ scope: 'cwd', cwd })"), 'stored metadata lookup must call the new object signature');
    assert.ok(routes.includes("const scope: 'all' | 'cwd' = rawScope === 'cwd' ? 'cwd' : 'all'"), 'route must default missing or unknown scope to all');
    assert.ok(routes.includes("absolute cwd required for cwd scope"), 'route must validate cwd scope before ACP work');
});

test('code canvas accepts replay user chunks and loads stored sessions without dropping replayed transcript', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const replay = read('public/manager/src/code/code-transcript-replay.ts');
    const types = read('src/code-mode/types.ts');
    const host = read('src/code-mode/acp-host.ts');
    const client = read('public/manager/src/code/code-session-client.ts');

    assert.ok(types.includes('export interface CodeSessionReplayEvent'), 'backend session type must expose replay event fallback');
    assert.ok(types.includes('replayEvents?: CodeSessionReplayEvent[]'), 'backend session info must return replay events when captured');
    assert.ok(client.includes('export interface CodeSessionReplayEvent'), 'frontend client type must expose replay event fallback');
    assert.ok(client.includes('replayEvents?: CodeSessionReplayEvent[]'), 'frontend session type must carry replay events');
    assert.ok(host.includes('#replayCaptures = new Map<string, Set<CodeSessionReplayEvent[]>>()'), 'ACP host must support concurrent same-session replay captures');
    assert.ok(host.includes('const event = `code_${kind}`'), 'ACP host must reuse the same event name for publish and replay capture');
    assert.ok(host.includes('for (const capture of captures)'), 'ACP host must append replay events to all active load captures');
    assert.ok(host.includes('capture.push({ event, sessionId, update })'), 'ACP host must capture replay update payloads');
    assert.ok(host.includes('if (captures)') && host.includes('return;\n        }\n        // Sanitized public lane'), 'ACP host must not publish loadSession replay events to SSE after capturing them');
    assert.ok(host.includes('const replayCapture: CodeSessionReplayEvent[] = []'), 'loadSession must create a per-call replay capture');
    assert.ok(host.includes('captures.add(replayCapture)'), 'loadSession must register replay capture before session/load');
    assert.ok(host.includes('captures.delete(replayCapture)'), 'loadSession must remove replay capture in cleanup');
    assert.ok(host.includes('if (captures.size === 0) this.#replayCaptures.delete(sessionId)'), 'loadSession must delete empty capture sets');
    assert.ok(host.includes('if (replayCapture.length > 0) info.replayEvents = replayCapture'), 'loadSession must return captured replay fallback events');
    assert.ok(replay.includes('function replayEventsToTranscriptEntries'), 'Code mode must convert response replay fallback events into transcript entries');
    assert.ok(canvas.includes("kind === 'code_user_message_chunk'"), 'CodeCanvas must handle replayed user message chunks');
    assert.ok(replay.includes("event.event === 'code_user_message_chunk'"), 'replay fallback must handle replayed user chunks');
    assert.ok(replay.includes("event.event === 'code_agent_message_chunk'"), 'replay fallback must handle assistant chunks');
    assert.ok(replay.includes("event.event === 'code_agent_thought_chunk'"), 'replay fallback must handle thought chunks');
    assert.ok(replay.includes("event.event === 'code_tool_call'"), 'replay fallback must handle tool calls');
    assert.ok(replay.includes("event.event === 'code_tool_call_update'"), 'replay fallback must handle tool call updates');
    assert.ok(replay.includes("role: 'user', text"), 'replayed user chunks must render as user transcript entries');

    const loadBlockStart = canvas.indexOf('onLoadSession={(id, cwd) => {');
    const loadBlockEnd = canvas.indexOf('onNewSession=', loadBlockStart);
    assert.ok(loadBlockStart > 0 && loadBlockEnd > loadBlockStart, 'stored session load handler must be present');
    const loadBlock = canvas.slice(loadBlockStart, loadBlockEnd);

    const refIndex = loadBlock.indexOf('activeSessionIdRef.current = id');
    const activeIndex = loadBlock.indexOf('setActiveSessionId(id)');
    const clearIndex = loadBlock.indexOf('setMessages([])');
    const loadIndex = loadBlock.indexOf('client.loadSession(id, cwd)');
    assert.ok(refIndex >= 0 && refIndex < loadIndex, 'activeSessionIdRef must be set before client.loadSession');
    assert.ok(activeIndex >= 0 && activeIndex < loadIndex, 'active session state must be set before client.loadSession');
    assert.ok(clearIndex >= 0 && clearIndex < loadIndex, 'transcript must be cleared before replay can arrive');
    assert.equal(loadBlock.indexOf('setMessages([])', loadIndex), -1, 'success path must not clear replayed transcript after load');
    assert.equal(loadBlock.indexOf("setSessionTitle('')", loadIndex), -1, 'success path must not clear loaded title after load');
    assert.ok(loadBlock.includes('const session = await client.loadSession(id, cwd)'), 'load handler must read returned session metadata');
    assert.ok(loadBlock.includes('if (session.title) setSessionTitle(session.title)'), 'load handler must preserve returned JWC title in header');
    assert.ok(loadBlock.includes('const replayFallback = replayEventsToTranscriptEntries(session.replayEvents ?? [])'), 'load handler must convert returned replay fallback events');
    assert.ok(canvas.includes('const loadingSessionIdRef = useRef<string | null>(null)'), 'stored session loading must track the session being hydrated');
    assert.ok(canvas.includes("event.sessionId === loadingSessionIdRef.current"), 'stored session load must ignore same-session SSE while replay is authoritative');
    assert.ok(loadBlock.includes('loadingSessionIdRef.current = id'), 'stored session load must mark the active hydrate before setting the active session id');
    assert.ok(loadBlock.includes('if (activeSessionIdRef.current !== id) return'), 'late load responses must not overwrite a newer active session');
    assert.ok(loadBlock.includes('setMessages(replayFallback)'), 'stored session load must authoritatively hydrate from returned replay events');
    assert.equal(loadBlock.includes('prev.length > 0 ? prev : replayFallback'), false, 'stored session load must not keep partial race-populated transcript over full replay');
    assert.ok(loadBlock.includes('if (loadingSessionIdRef.current === id) loadingSessionIdRef.current = null'), 'stored session load must clear the hydrate guard in finally');
    assert.ok(canvas.includes('const replayedAssistantTextsRef = useRef<Set<string>>(new Set())'), 'CodeCanvas must track replayed assistant chunks for duplicate suppression after load');
    assert.ok(canvas.includes('replayedAssistantTextsRef.current.has(text)'), 'live assistant chunks must suppress exact replay duplicates after a stored load');
    assert.ok(loadBlock.includes('pendingUserEchoRef.current = null'), 'stored session load must clear pending prompt echo state');
    assert.ok(loadBlock.includes('setSending(false)'), 'stored session load must clear stale live-stream Thinking state');
    assert.equal(loadBlock.includes('messages.length'), false, 'load handler must not read stale messages.length after await');
    assert.ok(loadBlock.includes('if (activeSessionIdRef.current === id)'), 'load failure must only restore state when failed id is still active');

    const selectBlockStart = canvas.indexOf('const applySelectedLiveSession = (session: CodeSession) => {');
    const selectBlockEnd = canvas.indexOf('if (!port)', selectBlockStart);
    assert.ok(selectBlockStart > 0 && selectBlockEnd > selectBlockStart, 'live session selection helper must be present');
    const selectBlock = canvas.slice(selectBlockStart, selectBlockEnd);
    assert.ok(selectBlock.includes('replayEventsToTranscriptEntries(session.replayEvents ?? [])'), 'live selection must hydrate from returned replayEvents');
    assert.ok(selectBlock.includes('activeSessionIdRef.current = session.sessionId'), 'live selection must set ref before replay events can arrive');
    assert.ok(selectBlock.includes('setActiveSessionId(session.sessionId)'), 'live selection must set active session state');
    assert.ok(selectBlock.includes('skipNextCwdResetRef.current = true'), 'live selection must guard cwd reset before changing cwd');
    assert.ok(selectBlock.includes('setCodeWorkingDir(session.cwd)'), 'live selection must switch the Code cwd to the selected session cwd');
    assert.equal(selectBlock.includes('client.loadSession'), false, 'live selection must not ACP-load already-live sessions');

    const resetBlockStart = canvas.indexOf('useEffect(() => {', canvas.indexOf('skipNextCwdResetRef'));
    const resetBlockEnd = canvas.indexOf('}, [codeWorkingDir]);', resetBlockStart);
    const resetBlock = canvas.slice(resetBlockStart, resetBlockEnd);
    assert.ok(resetBlock.includes('if (skipNextCwdResetRef.current)'), 'cwd reset effect must consume the live-selection guard');
    assert.ok(resetBlock.includes('return;'), 'cwd reset guard must return before clearing active session state');
});

test('code canvas coalesces optimistic user prompt echo from SSE', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const types = read('public/manager/src/code/code-types.ts');

    assert.ok(types.includes("transient?: 'pending-user-echo'"), 'transcript entries must allow an internal pending user echo marker');
    assert.ok(canvas.includes('const pendingUserEchoRef = useRef<string | null>(null)'), 'CodeCanvas must track the prompt text awaiting SSE echo');
    assert.ok(canvas.includes("transient: 'pending-user-echo'"), 'optimistic submit row must be marked as a pending echo');
    assert.ok(canvas.includes("msg.transient === 'pending-user-echo'"), 'SSE user chunk handler must locate the optimistic row');
    assert.ok(canvas.includes("updated[optimisticIndex] = { role: 'user', text,"), 'SSE echo must replace, not append, the optimistic user row');
    assert.ok(canvas.includes('pendingUserEchoRef.current = null'), 'pending echo state must be cleared after merge or reset');
});

test('code canvas owns code cwd override independent from manager instance selection', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.ok(canvas.includes('const [codeWorkingDir, setCodeWorkingDir] = useState(workingDir)'), 'CodeCanvas must keep an internal Code cwd override');
    assert.ok(canvas.includes('const handleWorkingDirChange = useCallback'), 'CodeCanvas must own the cwd apply handler');
    assert.ok(canvas.includes('setCodeWorkingDir(next)'), 'cwd apply must update Code mode immediately before parent persistence');
    assert.ok(canvas.includes('onWorkingDirChange?.(path)'), 'cwd apply should still persist through the manager settings bridge');
    assert.ok(canvas.includes('client.getGitInfo(codeWorkingDir)'), 'git/worktree context must use the Code cwd override');
    assert.ok(canvas.includes('const cwd = codeWorkingDir ||'), 'new sessions must be created in the Code cwd override');
    assert.ok(canvas.includes('workingDir={codeWorkingDir}'), 'session list, header, and transcript must render the Code cwd override');
    assert.equal(canvas.includes('const cwd = workingDir ||'), false, 'new sessions must not fall back to the manager instance workingDir prop');
});

test('code workspace is a picker button before first Send and a plain chip after (slice 210)', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const workbench = read('public/manager/src/code/CodeWorkbench.tsx');
    const header = read('public/manager/src/code/CodeWorkspaceHeader.tsx');
    const css = read('public/manager/src/code/code.css');

    // New picker/chip contract: editable picker button before the workspace is frozen,
    // plain chip once frozen (first Send) or a session is active (loaded session).
    assert.ok(header.includes('workspaceFrozen?: boolean'), 'header props must include workspaceFrozen');
    assert.ok(header.includes('onPickWorkingDir?: (() => Promise<string | null>)'), 'header must receive a parent pick callback');
    assert.ok(header.includes('const frozen = workspaceFrozen || cwdLocked'), 'header must freeze on workspaceFrozen OR active/loaded session');
    assert.ok(header.includes('const canPick = Boolean(!frozen'), 'picker is enabled only while not frozen');
    assert.ok(header.includes('code-workspace-picker'), 'header must render a picker button before freeze');
    assert.ok(header.includes('code-workspace-chip'), 'header must render a plain chip when frozen');
    assert.ok(header.includes('aria-label={`Current Code workspace:'), 'frozen chip exposes the full path to assistive tech');
    assert.ok(header.includes('code-workspace-cwd-error'), 'header must surface picker errors without blocking the app');

    // Removed legacy header affordances (no text input / Apply / lock copy / path pills).
    for (const gone of ['code-workspace-cwd-input', 'code-workspace-cwd-apply', 'fixed for this session', 'code-workspace-repo', 'code-workspace-path', "from '../panels/desktop-bridge'"]) {
        assert.equal(header.includes(gone), false, `header must no longer contain legacy affordance: ${gone}`);
    }

    // The pre-session sync + manual-change guards are unchanged.
    const syncStart = canvas.indexOf('useEffect(() => {');
    const syncEnd = canvas.indexOf('const handleWorkingDirChange', syncStart);
    const syncBlock = canvas.slice(syncStart, syncEnd);
    assert.ok(syncBlock.includes('if (activeSessionIdRef.current || activeSessionId) return'), 'workingDir prop sync must not overwrite cwd while a session is active');
    assert.ok(syncBlock.includes('setCodeWorkingDir(workingDir)'), 'workingDir prop sync must still update cwd before a session starts');

    const handlerStart = canvas.indexOf('const handleWorkingDirChange = useCallback');
    const handlerEnd = canvas.indexOf('}, [activeSessionId, onWorkingDirChange, workspaceFrozen])', handlerStart);
    const handlerBlock = canvas.slice(handlerStart, handlerEnd);
    assert.ok(handlerEnd > handlerStart, 'handleWorkingDirChange dep array must include workspaceFrozen (slice 213)');
    assert.ok(handlerBlock.includes('activeSessionId || workspaceFrozen) return'), 'manual cwd changes must be ignored while a session is active OR the workspace is frozen (slice 213)');
    assert.ok(handlerBlock.includes('setCodeWorkingDir(next)'), 'manual cwd changes must still update cwd before a session starts');

    // Parent owns pick (Electron bridge -> web /api/code/workspace/pick fallback) and freeze lifecycle.
    assert.ok(canvas.includes('const handlePickWorkspace = useCallback'), 'CodeCanvas owns the pick handler');
    assert.ok(canvas.includes('desktop?.folder?.pickFolder') && canvas.includes('client.pickWorkspace()'), 'pick tries the Electron bridge then the web route');
    assert.ok(canvas.includes('setWorkspaceFrozen(true)'), 'first Send freezes the workspace');
    assert.ok(canvas.includes('setWorkspaceFrozen(false)'), 'new session unfreezes the workspace');
    assert.ok(workbench.includes('workspaceFrozen={props.workspaceFrozen}') && workbench.includes('onPickWorkingDir={props.onPickWorkingDir}'), 'CodeWorkbench threads picker props to the header');
    assert.ok(workbench.includes('cwdLocked={Boolean(props.activeSessionId)}'), 'CodeWorkbench still passes active session lock state to the header');

    for (const selector of ['.code-workspace-picker', '.code-workspace-chip', '.code-workspace-cwd-error']) {
        assert.ok(css.includes(selector), `code.css must include ${selector}`);
    }
    assert.equal(css.includes('.code-workspace-cwd-input'), false, 'legacy cwd input style must be removed');
});

test('git-info route still exposes repo root / worktree data; header shows a compact worktree pill (slice 210)', () => {
    const header = read('public/manager/src/code/CodeWorkspaceHeader.tsx');
    const client = read('public/manager/src/code/code-session-client.ts');
    const routes = read('src/routes/code.ts');

    // The git-info contract (route + client type) is unchanged by slice 210.
    for (const token of ['repoRoot?: string', 'relativePath?: string', 'currentWorktree?:']) {
        assert.ok(client.includes(token), `CodeGitInfo must include ${token}`);
    }
    assert.ok(routes.includes("['rev-parse', '--show-toplevel']"), 'git-info route must resolve the repo root');
    assert.ok(routes.includes('relative(repoRoot, realOrOriginal(cwd))'), 'git-info route must expose realpath-normalized cwd relative to repo root');
    assert.ok(routes.includes('const currentWorktree = worktrees.find(worktree => worktree.current)'), 'git-info route must identify the current worktree');
    assert.ok(routes.includes('current: path === repoRoot'), 'git-info worktree current flag must compare against repo root, not nested cwd');

    // Slice 210 removed the path-repeating repo/path pills; the header keeps a compact
    // worktree pill (count only) and the picker/chip already carries the full path via title.
    assert.ok(header.includes('worktree {worktreeCount}'), 'header must render a compact worktree count pill');
    assert.ok(header.includes('currentWorktree?.path'), 'header may still title the worktree pill with the current worktree path');
    assert.equal(header.includes('code-workspace-repo'), false, 'slice 210 removes the repo root pill');
    assert.equal(header.includes('code-workspace-path'), false, 'slice 210 removes the cwd-relative path pill');
});

test('code transcript preserves failed tool state and remains scrollable after replay', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    const replay = read('public/manager/src/code/code-transcript-replay.ts');
    const scroll = read('public/manager/src/code/use-code-transcript-scroll.ts');
    const css = read('public/manager/src/code/code.css');

    assert.ok(replay.includes('function normalizeToolStatus'), 'Code mode must centralize tool status normalization');
    assert.ok(replay.includes("if (value === 'failed' || value === 'error' || value === 'errored') return 'failed'"), 'failed/error tool statuses must normalize to failed');
    assert.ok(replay.includes("toolStatus: normalizeToolStatus(status)"), 'tool call creation must preserve failed status instead of mapping it to done');
    assert.ok(replay.includes('if (status) entry.toolStatus = normalizeToolStatus(status)'), 'tool call updates must preserve failed status instead of mapping it to done');
    assert.equal(canvas.includes("status === 'completed' || status === 'failed' ? 'done'"), false, 'failed tool statuses must not be coerced to done');
    assert.equal(canvas.includes("status === 'completed' || status === 'failed') entry.toolStatus = 'done'"), false, 'failed tool updates must not be coerced to done');

    assert.ok(scroll.includes('const scrollTranscriptToBottom = useCallback'), 'Code mode must centralize transcript bottom scrolling');
    assert.ok(scroll.includes('const latestTranscriptFootprint = useMemo'), 'Code mode must track rendered transcript changes for replay/load scroll');
    assert.ok(scroll.includes('latestTranscriptFootprint'), 'auto-scroll must run from rendered message state, not only event delivery');
    assert.ok(scroll.includes('window.setTimeout'), 'auto-scroll must re-check after lazy Markdown height settles');

    assert.ok(transcript.includes('role="log"'), 'transcript must expose log semantics');
    assert.ok(transcript.includes('aria-live="polite"'), 'transcript must announce appended output politely');
    assert.ok(transcript.includes('tabIndex={0}'), 'transcript must be keyboard focusable for scroll keys');
    assert.ok(transcript.includes('function handleTranscriptKeyDown'), 'transcript must own keyboard scroll handling');
    assert.ok(scroll.includes('window.addEventListener(\'keydown\', onWorkbenchKeyDown)'), 'Code mode must provide workbench-level scroll keys when transcript is not focused');
    assert.ok(scroll.includes('isEditableKeyboardTarget(event.target)'), 'workbench scroll keys must not steal composer input');
    assert.ok(scroll.includes("key === 'd' || key === 'j' || event.key === 'PageDown'"), 'workbench scroll keys must include d/j/PageDown');
    assert.ok(scroll.includes("event.key === 'Home'"), 'workbench scroll keys must include Home');
    for (const token of ["key === 'd'", "key === 'j'", "event.key === 'PageDown'", "event.key === 'End'"]) {
        assert.ok(transcript.includes(token), `transcript keyboard handler must include ${token}`);
    }
    assert.ok(transcript.includes('isEditableTarget(event.target)'), 'transcript must not steal keys from composer inputs');
    assert.ok(transcript.includes("open={status === 'running' || failed}"), 'failed tools must open by default so error details are visible');
    assert.ok(transcript.includes('code-tool-status'), 'tool rows must keep visible status labels');
    assert.ok(transcript.includes('code-tool-error-snippet'), 'failed tools must show a visible error snippet');

    assert.ok(css.includes('.code-canvas-main'), 'code.css must style the Code main pane');
    assert.ok(css.includes('min-height: 0;'), 'code.css must include flex min-height containment');
    assert.ok(css.includes('scroll-padding-bottom: 160px'), 'transcript must reserve bottom scroll space near composer/footer');
    assert.ok(css.includes('.code-transcript:focus-visible'), 'keyboard-focused transcript must show focus affordance');
    assert.ok(css.includes('.code-session-list-error'), 'session list load errors must be styled');
    assert.ok(css.includes('.code-tool-failed'), 'failed tool rows must have distinct styling');
    assert.ok(css.includes('.code-tool-error-snippet'), 'failed tool error snippet must be styled');
});

test('code tool rows normalize args output error diff and json schema', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    const types = read('public/manager/src/code/code-types.ts');
    const css = read('public/manager/src/code/code-workbench.css');

    assert.ok(types.includes("type: 'args' | 'output' | 'error' | 'diff' | 'json' | 'text'"), 'ToolContent must enumerate the card schema variants');
    assert.ok(types.includes('export function normalizeToolContentFromUpdate'), 'tool update normalization must be centralized');
    for (const token of ["update['args']", "update['arguments']", "update['input']", "update['rawOutput']", "update['output']", "update['error']", "update['errorMessage']"]) {
        assert.ok(types.includes(token), `tool normalization must read ${token}`);
    }
    assert.ok(canvas.includes('normalizeToolContentFromUpdate(update)'), 'live and replay tool events must use normalized tool content');
    assert.equal(canvas.includes("const content = (update['content'] ?? []) as ToolContent[]"), false, 'CodeCanvas must not cast raw tool content directly into transcript cards');

    assert.ok(transcript.includes('function toolSummaryLabel(msg: TranscriptEntry): string'), 'tool transcript must centralize compact summary labels');
    assert.ok(transcript.includes('safeToolContentLine(msg)'), 'tool summary must derive safe one-line details from normalized content');
    assert.ok(transcript.includes('className="code-tool-chevron"'), 'tool summary must render a leading > marker');
    assert.ok(transcript.includes('{toolSummaryLabel(msg)}'), 'tool summary must render the compact label instead of only the raw tool name');
    assert.ok(transcript.includes('code-tool-section-label'), 'tool transcript must render labels for normalized sections');
    for (const selector of ['.code-tool-chevron', '.code-tool-name', '.code-tool-args', '.code-tool-output', '.code-tool-error', '.code-tool-json', '.code-tool-diff']) {
        assert.ok(css.includes(selector), `tool card CSS must include ${selector}`);
    }
});

test('code permission mode uses JWC ACP option ids and records transcript audit', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');
    const queue = read('public/manager/src/code/CodePermissionQueue.tsx');
    const footer = read('public/manager/src/code/ComposerFooter.tsx');
    const popup = read('public/manager/src/code/CodeCommandPopup.tsx');
    const picker = read('public/manager/src/code/CodePermissionModePicker.tsx');
    const transcript = read('public/manager/src/code/CodeTranscript.tsx');
    const flow = read('public/manager/src/code/code-permission-flow.ts');
    const types = read('public/manager/src/code/code-types.ts');
    const css = read('public/manager/src/code/code-workbench.css');

    assert.ok(types.includes("export type PermissionMode = 'ask' | 'always-allow' | 'always-deny'"), 'permission modes must be explicit and no local auto mode');
    assert.ok(types.includes("export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'"), 'permission option kinds must match JWC ACP ids');
    assert.ok(types.includes('export const PERMISSION_ACTION_TONES'), 'permission actions must have canonical tone classes');
    assert.ok(types.includes('export const PERMISSION_MODE_OPTIONS'), 'permission mode labels/details must be centralized');
    assert.ok(types.includes('export function resolvePermissionOption'), 'JWC option resolution must be centralized');
    assert.ok(types.includes("PERMISSION_ACTION_ORDER: PermissionOptionKind[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always']"), 'manual queue must prefer the four JWC actions in order');
    assert.ok(types.includes('permissionAuditEntry'), 'permission decisions must create transcript audit entries');
    assert.ok(types.includes("role: 'permission'"), 'transcript entries must support permission audit role');

    assert.ok(canvas.includes("useState<PermissionMode>('always-allow')"), 'Code mode must default to the explicit always-allow policy');
    assert.ok(flow.includes("permissionMode === 'always-allow' ? 'allow_always' : 'reject_always'"), 'automatic modes must resolve JWC always option ids');
    assert.ok(flow.includes('resolvePermissionOption(permission.options, targetKind)'), 'automatic permission answers must use resolver output');
    assert.ok(flow.includes('client.answerPermission(permission.permissionId, option.optionId)'), 'automatic permission answers must pass JWC option id through');
    assert.ok(flow.includes("decision: 'missing_option'"), 'missing JWC options must be audit-visible');
    assert.ok(flow.includes("decision: 'answer_error'"), 'answer errors must be audit-visible');
    assert.equal(canvas.includes(": 'allow'"), false, 'CodeCanvas must not synthesize fake allow option ids');

    assert.ok(queue.includes('PERMISSION_ACTION_ORDER.map'), 'permission request card must render the four canonical actions');
    assert.ok(queue.includes('PERMISSION_ACTION_TONES[action]'), 'permission request buttons must use per-action tone classes');
    for (const label of ['Allow once', 'Always allow', 'Deny once', 'Always deny']) {
        assert.ok(types.includes(label), `permission labels must include ${label}`);
    }
    assert.ok(queue.includes('disabled={!option}'), 'missing JWC options must disable the corresponding action');
    assert.equal(queue.includes("onAnswer(p.permissionId, 'allow')"), false, 'permission queue must not send fake allow option ids');

    assert.equal(footer.includes('<option value="auto">Auto</option>'), false, 'footer must remove decorative auto mode');
    assert.equal(popup.includes('<option value="auto">Auto</option>'), false, 'settings popup must remove decorative auto mode');
    assert.equal(popup.includes('<select value={permissionMode}'), false, 'settings popup must not use native select for permission mode');
    assert.ok(footer.includes('PERMISSION_MODE_OPTIONS'), 'footer must reuse shared permission mode copy');
    assert.ok(picker.includes('Default: Always allow'), 'popup must name the explicit new default');
    assert.ok(picker.includes('JWC persistent options'), 'settings popup must explain automatic mode semantics');

    assert.ok(transcript.includes('code-permission-audit'), 'transcript must render permission audit cards');
    assert.ok(transcript.includes('permissionDecisionLabel'), 'transcript must label permission decisions');
    assert.ok(transcript.includes('toneClass'), 'transcript audit rows must carry allow/deny tone classes');
    assert.ok(css.includes('.code-permission-audit'), 'permission audit cards must have styles');
    for (const selector of ['.code-permission-btn.is-allow-once', '.code-permission-btn.is-allow-always', '.code-permission-btn.is-deny-once', '.code-permission-btn.is-deny-always', '.code-permission-audit.is-allow', '.code-permission-audit.is-deny']) {
        assert.ok(css.includes(selector), `permission CSS must include ${selector}`);
    }
});

test('code backend normalizes JWC session title metadata and returns title on load', () => {
    const types = read('src/code-mode/types.ts');
    const host = read('src/code-mode/acp-host.ts');
    const client = read('public/manager/src/code/code-session-client.ts');

    assert.ok(types.includes('title?: string;'), 'CodeSessionInfo must carry optional title');
    assert.ok(types.includes('StoredCodeSessionInfo'), 'stored session metadata type must exist');
    for (const token of ['firstMessage?: string', 'updatedAt?: string', 'messageCount?: number', 'size?: number']) {
        assert.ok(types.includes(token), `stored metadata type must include ${token}`);
        assert.ok(client.includes(token), `frontend stored metadata type must include ${token}`);
    }

    assert.ok(host.includes('function normalizeStoredSession'), 'ACP host must normalize stored session metadata');
    assert.ok(host.includes("stringField(raw['title'])"), 'backend must normalize title');
    assert.ok(host.includes("stringField(raw['firstMessage'])"), 'backend must normalize firstMessage');
    assert.ok(host.includes("stringField(raw['updatedAt'])"), 'backend must normalize updatedAt');
    assert.ok(host.includes("stringField(raw['updatedAt']) ?? stringField(raw['modified'])"), 'backend must accept JWC top-level modified timestamp');
    assert.ok(host.includes("objectField(raw['_meta'])"), 'backend must normalize ACP _meta');
    assert.ok(host.includes("numberField(raw['messageCount']) ?? numberField(meta['messageCount'])"), 'backend must prefer JWC top-level messageCount and keep _meta fallback');
    assert.ok(host.includes("numberField(meta['messageCount'])"), 'backend must normalize messageCount');
    assert.ok(host.includes("numberField(raw['size']) ?? numberField(meta['size'])"), 'backend must prefer JWC top-level size and keep _meta fallback');
    assert.ok(host.includes("numberField(meta['size'])"), 'backend must normalize size');
    assert.ok(host.includes('const stored = await this.#findStoredSession(sessionId, cwd)'), 'loadSession must find stored metadata');
    assert.ok(host.includes('if (stored?.title) info.title = stored.title'), 'loadSession must attach stored title to returned session');
});

test('code ACP host prefers bundled jawcode CLI before global jwc fallback', () => {
    const host = read('src/code-mode/acp-host.ts');

    const localBinIndex = host.indexOf("join(process.cwd(), 'node_modules', '.bin', 'jwc')");
    const globalFallbackIndex = host.indexOf("return { cmd: 'jwc', args: ['--mode', 'acp'] }");
    assert.ok(localBinIndex > 0, 'ACP host must consider the package-local jawcode .bin/jwc');
    assert.ok(globalFallbackIndex > localBinIndex, 'package-local jawcode .bin/jwc must be tried before global jwc fallback');
    assert.ok(host.includes('stale global jwc shim'), 'resolver comment must document why local jawcode is preferred');
    assert.ok(host.includes("join(MODULE_DIR, '..', '..', '..', 'node_modules', '.bin', 'jwc')"), 'dist runtime must resolve package-local jawcode from MODULE_DIR');
});
