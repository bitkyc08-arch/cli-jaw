#!/usr/bin/env python3
"""Drive the compiled chat CLI through an OS PTY and deterministic SSE fixture."""
import fcntl
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

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    cli = subprocess.Popen(['node', str(ROOT / 'dist/bin/cli-jaw.js'), 'chat', '--port', str(port)],
                           cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave,
                           start_new_session=True)
    os.close(slave)
    slave = None
    read_until(lambda: b'for shortcuts' in capture, 'interactive composer')
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
    event(13, 'turn-end', status='stopped', finalText='PTY_FINAL_SENTINEL')
    request('/fixture/event', dict(type='agent_done', traceRunId='tui-pty-run', runtimeFinality='present',
                                   runtimeStatus='stopped', text='PTY_FINAL_SENTINEL'))
    read_until(lambda: b'PTY_FINAL_SENTINEL' in capture, 'authoritative final')
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
        'controls': ['submit', 'Ctrl+O expand', 'Escape stop', 'idle Ctrl+C exit'],
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
