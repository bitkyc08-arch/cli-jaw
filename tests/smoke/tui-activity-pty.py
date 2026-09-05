#!/usr/bin/env python3
"""Drive the compiled chat CLI through an OS PTY and deterministic SSE fixture."""
import fcntl
import base64
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / '.codexclaw' / 'evidence' / 'tui-activity-pty'
EVIDENCE.mkdir(parents=True, exist_ok=True)
runtime = Path(tempfile.mkdtemp(prefix='tui-activity-pty-'))
env = dict(os.environ, CLI_JAW_HOME=str(runtime / 'home'), TMPDIR=str(runtime),
           TSX_DISABLE_CACHE='1', TERM='xterm-256color', CI='1', NO_COLOR='1')
(runtime / 'home').mkdir()
capture = bytearray()
sizes = [{'offset': 0, 'columns': 80, 'rows': 24}]
probe_deadline = time.monotonic() + 150
fixture = None
cli = None
raw_cli = None
master = None
slave = None


def read_until(predicate, label, timeout=10):
    deadline = min(time.monotonic() + timeout, probe_deadline)
    while time.monotonic() < deadline:
        if predicate():
            return
        if cli and cli.poll() is not None:
            raise AssertionError(f'CLI exited {cli.returncode} while waiting for {label}')
        ready, _, _ = select.select([master], [], [], min(.1, max(0, deadline - time.monotonic())))
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                raise AssertionError(f'PTY closed while waiting for {label}') from error
            capture.extend(chunk)
    raise AssertionError(f'PTY timeout: {label}')


try:
    fixture = subprocess.Popen([str(ROOT / 'node_modules/.bin/tsx'),
                                str(ROOT / 'tests/fixtures/tui-activity-server.mts')],
                               cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    ready, _, _ = select.select([fixture.stdout], [], [], 10)
    assert ready, 'fixture did not report ready'
    port = json.loads(fixture.stdout.readline())['port']
    base = f'http://127.0.0.1:{port}'

    def request(path, body=None):
        if time.monotonic() >= probe_deadline:
            raise TimeoutError('PTY probe deadline')
        encoded = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=encoded,
                                     headers={'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=2) as response:
            return json.load(response)

    def current_screen():
        screen_input = EVIDENCE / 'screen-input.json'
        screen_input.write_text(json.dumps({'data': base64.b64encode(capture).decode(), 'sizes': sizes}))
        return json.loads(subprocess.check_output(['node', str(ROOT / 'tests/smoke/tui-pty-screen.mjs'), str(screen_input)], cwd=ROOT))

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    cli = subprocess.Popen(['node', str(ROOT / 'dist/bin/cli-jaw.js'), 'chat', '--port', str(port)],
                           cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave,
                           start_new_session=True)
    os.close(slave)
    slave = None
    read_until(lambda: b'F6 history' in capture, 'interactive composer')
    os.write(master, b'Inspect the fixture\r')
    read_until(lambda: any(row['path'] == '/api/message' for row in request('/fixture/state')['requests']), 'message HTTP route')
    ident = dict(version=1, runId='tui-pty-run', sessionId='tui-pty-chat', scope='local:tui-pty-chat', turnId='tui-pty-turn')

    def event(seq, kind, **fields):
        request('/fixture/event', dict(type='agent_runtime', **ident, seq=seq, kind=kind, **fields))

    event(1, 'turn-start', provider='codex-app')
    unicode_path = '한글/👩‍💻-file.ts'
    event(7, 'tool', itemId='read-1', name='Read', status='running', input=unicode_path, output='PTY_TOOL_DETAIL')
    read_until(lambda: b'Activity' in capture, 'live Activity')
    before = len(capture)
    os.write(master, b'\x0f')
    read_until(lambda: b'PTY_TOOL_DETAIL' in capture[before:], 'Ctrl+O expanded tool output')
    os.write(master, b'\x1b')
    read_until(lambda: any(row['path'] == '/api/stop' for row in request('/fixture/state')['requests']), 'Escape stop HTTP route')
    request('/fixture/disconnect', {})
    event(9, 'tool', itemId='read-1', name='Read', status='done', input=unicode_path, output='OFFLINE_TOOL_DETAIL')
    event(13, 'turn-end', status='stopped', finalText='PTY_FINAL_SENTINEL')
    read_until(lambda: request('/fixture/state')['connections'] >= 2, 'SSE reconnect')
    read_until(lambda: b'PTY_FINAL_SENTINEL' in capture, 'replayed authoritative final')
    # Duplicate terminal delivery after restore must not produce another answer item.
    request('/fixture/event', dict(type='agent_done', traceRunId='tui-pty-run', runtimeFinality='present',
                                   runtimeStatus='stopped', text='PTY_FINAL_SENTINEL'))
    read_until(lambda: b'PTY_FINAL_SENTINEL' in capture, 'authoritative final')
    os.write(master, b'draft')
    before = len(capture)
    os.write(master, b'\x1b[17~')
    read_until(lambda: b'Activity history' in capture[before:], 'F6 history')
    read_until(lambda: b'seq 7' in capture[before:], 'retained tool record')
    resize_start = len(capture)
    sizes.append({'offset': len(capture), 'columns': 40, 'rows': 16})
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 16, 40, 0, 0))
    os.kill(cli.pid, signal.SIGWINCH)
    narrow_border = ('┌' + '─' * 38 + '┐').encode()
    read_until(lambda: narrow_border in capture[resize_start:], '40-column resize redraw')
    os.write(master, b'\x1b[B\r\x1b[6~')
    read_until(lambda: b'OFFLINE_TOOL_DETAIL' in capture[before:], 'history navigation and detail after resize')
    screen = current_screen()
    (EVIDENCE / 'history-screen.json').write_text(json.dumps(screen, indent=2))
    assert any('Activity history' in row for row in screen['rows']), 'history not in actual terminal cells'
    assert any('OFFLINE_TOOL_DETAIL' in row for row in screen['rows']), 'retained detail not in terminal cells'
    reads_before_resize = len(request('/fixture/state')['reads'])
    for columns, rows in [(20, 20), (120, 30), (80, 24)]:
        offset = len(capture)
        sizes.append({'offset': offset, 'columns': columns, 'rows': rows})
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(cli.pid, signal.SIGWINCH)
        border = ('┌' + '─' * (columns - 2) + '┐').encode()
        read_until(lambda: border in capture[offset:], f'{columns}-column redraw')
        current = current_screen()
        assert any('seq 9' in row for row in current['rows']), 'resize changed the selected record'
        assert any('Activity history' in row for row in current['rows']), 'resize closed history'
        (EVIDENCE / f'history-{columns}.json').write_text(json.dumps(current, indent=2))
    assert len(request('/fixture/state')['reads']) == reads_before_resize, 'resize refetched history'
    assert capture.rfind(b'\x1b[?25l') > capture.rfind(b'\x1b[?25h'), 'inspector exposed the composer cursor'

    # A live run with >128 tools and >64KiB output must not move the inspected record.
    stress_id = 'tui-stress-run'
    def stress(seq, kind, **fields):
        packet = dict(type='agent_runtime', **ident, seq=seq, kind=kind, **fields)
        packet['runId'] = stress_id
        request('/fixture/event', packet)
    offset = len(capture)
    stress(1, 'turn-start', provider='codex-app')
    stress(2, 'tool', itemId='stress-0', name='Read', status='done', input=unicode_path, output='x' * 1000)
    read_until(lambda: b'working' in capture[offset:], 'background run while inspecting history')
    offset = len(capture)
    for index in range(1, 150):
        stress(index + 2, 'tool', itemId=f'stress-{index}', name='Read', status='done', input=unicode_path, output='x' * 1000)
    stress(160, 'turn-end', status='done', finalText='STRESS_FINAL_SENTINEL')
    request('/fixture/event', dict(type='agent_done', traceRunId=stress_id, runtimeFinality='present', runtimeStatus='done', text='STRESS_FINAL_SENTINEL'))
    read_until(lambda: b'idle' in capture[offset:], 'stress run settles')
    assert any('seq 9' in row for row in current_screen()['rows']), 'live output stole history selection'
    # Bracketed paste belongs to the inspector, never the command composer.
    os.write(master, b'\x1b[200~evil\r\x03\x1b[201~\x1b')
    def history_closed():
        rows = current_screen()['rows']
        return not any('Activity history' in row for row in rows) and any('draft' in row for row in rows)
    read_until(history_closed, 'Escape closes history and preserves composer draft')
    read_until(lambda: b'STRESS_FINAL_SENTINEL' in capture, 'bounded preview retains full final')
    assert b'Preview limited' in capture, 'preview bound did not activate'
    state = request('/fixture/state')
    assert len([row for row in state['requests'] if row['path'] == '/api/message']) == 1, 'paste submitted a prompt'
    assert len([row for row in state['requests'] if row['path'] == '/api/stop']) == 1, 'paste sent a stop'
    os.write(master, b'\x03')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            try:
                capture.extend(os.read(master, 65536))
            except OSError:
                break
        if cli.poll() is not None:
            break
    assert cli.wait(timeout=1) == 0, 'idle Ctrl+C did not exit cleanly'
    assert b'\x1b[?2004l' in capture and b'\x1b[?25h' in capture, 'terminal modes not restored'

    # Machine mode remains undecorated and forwards even unknown semantic versions.
    snapshots_before_raw = sum('/api/orchestrate/snapshot' in path for path in request('/fixture/state')['reads'])
    raw_cli = subprocess.Popen(['node', str(ROOT / 'dist/bin/cli-jaw.js'), 'chat', '--port', str(port), '--raw'],
                               cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    raw_cli.stdin.write(b'{"type":"message","text":"raw probe"}\n')
    raw_cli.stdin.close()
    raw_cli.stdin = None
    while len([row for row in request('/fixture/state')['requests'] if row['path'] == '/api/message']) < 2:
        assert raw_cli.poll() is None, 'raw CLI exited before sending'
        select.select([raw_cli.stdout], [], [], .05)
    raw_frame = dict(type='agent_runtime', version=999, runId='raw', sessionId='raw', scope='raw',
                     turnId='raw', seq=1, kind='message', text='\x1b]52;c;secret\x07漢字')
    raw_end = dict(type='agent_done', text='RAW_FINAL')
    request('/fixture/event', raw_frame)
    request('/fixture/event', raw_end)
    raw_out, raw_err = raw_cli.communicate(timeout=10)
    assert raw_cli.returncode == 0, raw_err.decode(errors='replace')
    expected = [json.dumps(value, ensure_ascii=False, separators=(',', ':')) for value in (raw_frame, raw_end)]
    assert raw_out.decode().splitlines() == expected, 'raw output was decorated or transformed'
    assert b'\x1b' not in raw_out, 'raw stream contains ANSI decoration'
    assert snapshots_before_raw == sum('/api/orchestrate/snapshot' in path for path in request('/fixture/state')['reads']), 'raw mode performed Activity bootstrap'
    (EVIDENCE / 'raw-output.ndjson').write_bytes(raw_out)
    (EVIDENCE / 'live-acceptance.json').write_text(json.dumps({
        'passed': True, 'route': 'dist/bin/cli-jaw.js chat -> SSE fixture', 'size': [80, 24],
        'controls': ['submit', 'Ctrl+O expand', 'Escape stop', 'reconnect replay', 'F6 history',
                     'arrows/Enter/PageDown', 'resize 20/40/80/120', '150-tool bounded preview', 'paste isolation',
                     'Escape draft preservation', 'idle Ctrl+C exit', 'verbatim raw NDJSON'],
        'requests': request('/fixture/state')['requests'],
        'scope': 'Real OS PTY/CLI route; deterministic server fixture, not a provider/journal proof'
    }, indent=2) + '\n')
    print('PTY Activity/history/reconnect/20-120cols/150tools/paste/raw/cleanup: PASS')
finally:
    (EVIDENCE / 'live-output.ansi').write_bytes(capture)
    pids = []
    for proc in (cli, raw_cli, fixture):
        if proc:
            pids.append(proc.pid)
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
    if master is not None:
        os.close(master)
    if slave is not None:
        os.close(slave)
    shutil.rmtree(runtime)
    (EVIDENCE / 'cleanup.json').write_text(json.dumps({'pids': pids, 'exited': True,
                                                     'homeRemoved': not runtime.exists()}) + '\n')
