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
fixture = None
cli = None
master = None
slave = None


def read_until(predicate, label, timeout=10):
    deadline = time.monotonic() + timeout
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
    event(7, 'tool', itemId='read-1', name='Read', status='running', input='긴 경로/파일.ts', output='PTY_TOOL_DETAIL')
    read_until(lambda: b'Activity' in capture, 'live Activity')
    before = len(capture)
    os.write(master, b'\x0f')
    read_until(lambda: b'PTY_TOOL_DETAIL' in capture[before:], 'Ctrl+O expanded tool output')
    os.write(master, b'\x1b')
    read_until(lambda: any(row['path'] == '/api/stop' for row in request('/fixture/state')['requests']), 'Escape stop HTTP route')
    request('/fixture/disconnect', {})
    event(9, 'tool', itemId='read-1', name='Read', status='done', input='긴 경로/파일.ts', output='OFFLINE_TOOL_DETAIL')
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
    # Bracketed paste belongs to the inspector, never the command composer.
    os.write(master, b'\x1b[200~evil\r\x03\x1b[201~\x1b')
    def history_closed():
        rows = current_screen()['rows']
        return not any('Activity history' in row for row in rows) and any('draft' in row for row in rows)
    read_until(history_closed, 'Escape closes history and preserves composer draft')
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
    (EVIDENCE / 'live-acceptance.json').write_text(json.dumps({
        'passed': True, 'route': 'dist/bin/cli-jaw.js chat -> SSE fixture', 'size': [80, 24],
        'controls': ['submit', 'Ctrl+O expand', 'Escape stop', 'reconnect replay', 'F6 history',
                     'arrows/Enter/PageDown', 'resize 40x16', 'paste isolation', 'Escape draft preservation', 'idle Ctrl+C exit'],
        'requests': request('/fixture/state')['requests'],
        'scope': 'Real OS PTY/CLI route; deterministic server fixture, not a provider/journal proof'
    }, indent=2) + '\n')
    print('PTY live Activity, disclosure, stop and final: PASS')
finally:
    (EVIDENCE / 'live-output.ansi').write_bytes(capture)
    pids = []
    for proc in (cli, fixture):
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
