#!/usr/bin/env python3
"""Owned initialization, bounded I/O, and fail-closed cleanup for the Cursor probe."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
UNIT = ROOT / 'devlog/_fin/260906_tui_parent_cascade'
if not UNIT.exists():
    UNIT = ROOT / 'devlog/_plan/260906_tui_parent_cascade'
MAX_BYTES = 8 * 1024 * 1024
ROWS = 180  # Entire bounded Activity preview fits; parent owns small-viewport coverage.


def digest(value):
    return hashlib.sha256(value).hexdigest()


def process_state(pid):
    """A failed ps is unknown until ESRCH independently proves absence."""
    try:
        raw = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command='],
                                      env=dict(os.environ, LC_ALL='C'), timeout=.7).strip()
        match = re.match(rb'^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$', raw)
        if match:
            return {'state': 'alive', 'fingerprint': digest(raw), 'startedAt': match[1].decode(),
                    'commandHash': digest(match[2])}
    except (subprocess.SubprocessError, OSError):
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return {'state': 'absent', 'evidence': 'ESRCH'}
    except OSError:
        pass
    return {'state': 'unknown'}


class CursorHarness:
    def __init__(self, args):
        self.args = args
        self.runtime = self.evidence = self.wire_path = self.tool_pid = None
        self.capture = bytearray()
        self.events, self.errors, self.procs = [], [], []
        self.owned = {}
        self.master = self.response = self.thread = None
        self.stopping, self.sse_ready = threading.Event(), threading.Event()
        self.started = time.monotonic()
        self.deadline = self.started + 150
        self.last_discovery = 0
        self.report = {'status': 'initializing', 'controls': [], 'proofs': [], 'cleanup': {}}


    def prepare(self):
        args = self.args
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, timeout=3).decode().strip()
        assert len(args.built_ready) >= 9, 'supply the explicit built-ready commit'
        production_delta = subprocess.check_output(['git', 'diff', '--name-only', args.built_ready, head, '--',
                                                    'src', 'bin', 'server.ts', 'package.json', 'package-lock.json'], cwd=ROOT, timeout=3).decode()
        assert not production_delta, 'production changed since built-ready receipt'
        prior = list((UNIT / 'evidence').glob('011_cursor_attempt_*'))
        assert len(prior) < 3, 'maximum three real probe attempts'
        evidence = UNIT / 'evidence' / f'011_cursor_attempt_{args.attempt}_{args.mode}'
        if any(p.name.endswith('_' + args.mode) for p in prior):
            assert args.repair_evidence and Path(args.repair_evidence).is_file(), 'retry requires concrete repair evidence'
        evidence.mkdir(parents=True, exist_ok=False)
        self.evidence = evidence
        self.runtime = Path(tempfile.mkdtemp(prefix='jaw-cursor-pty-'))
        for name in ('home', 'work', 'tmp'):
            (self.runtime / name).mkdir()
        self.wire_path = self.evidence / 'wire.ndjson'
        self.wire_path.touch(mode=0o600)
        self.markers = [f'CURSOR_{letter}_{uuid.uuid4().hex[:10]}' for letter in 'ABC']
        self.tool_pid = self.runtime / 'work/owned-tool.pid'
        self.tool = self.runtime / 'work/owned-hold.mjs'
        self.tool.write_text("import {writeFileSync} from 'node:fs';\n"
                             f"writeFileSync({json.dumps(str(self.tool_pid))},String(process.pid));\n"
                             "console.log('OWNED_TOOL_STARTED');\n"
                             "setTimeout(()=>console.log('OWNED_TOOL_FINISHED'),2500);\n")
        self.report = {'status': 'running', 'mode': args.mode, 'head': head,
                       'builtReady': args.built_ready, 'productionDiffSinceBuild': production_delta,
                       'build': {str(p.relative_to(ROOT)): {'sha256': digest(p.read_bytes()), 'mtimeNs': p.stat().st_mtime_ns}
                                 for p in (ROOT / 'dist/server.js', ROOT / 'dist/bin/cli-jaw.js')},
                       'sourceDiffHash': digest(subprocess.check_output(['git', 'diff', '--binary'], cwd=ROOT, timeout=3)),
                       'route': 'dist/bin/cli-jaw.js chat OS PTY -> dist/server.js -> native Cursor ACP',
                       'fixture': str(self.runtime), 'controls': [], 'proofs': [], 'limitations': [
                           'raw NDJSON and forced /queue steer are separately owned parent checks',
                           'real Stop observes absent finalText; empty-string finality requires deterministic parent coverage']}
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.base = f'http://127.0.0.1:{self.port}'
        self.report['base'] = self.base
        settings = dict(settingsSchemaVersion=4, runtimeDefaultMigration=None, multiSessionDefaultMigration=None,
                        cli='cursor', permissions='auto', port=str(self.port),
                        workingDir=str(self.runtime / 'work'), projectDirs=[str(self.runtime / 'work')],
                        activeOverrides={}, fallbackOrder=[],
                        perCli={'cursor': {'transport': 'native', 'model': 'grok-4.6', 'effort': 'medium'}},
                        messaging={'enabledChannels': [], 'homeChannel': 'telegram'}, memory={'enabled': False},
                        wiki={'enabled': False}, heartbeat={'enabled': False}, presentation={'mode': 'activity'},
                        multiSession={'enabled': True, 'maxConcurrent': 4, 'midRunPolicy': 'steer'},
                        network={'bindHost': '127.0.0.1', 'lanBypass': False},
                        agentTimeout={'absoluteHardCapMs': 120000})
        settings_file = self.runtime / 'home/settings.json'
        settings_file.touch(mode=0o600)
        settings_file.write_text(json.dumps(settings))
        # Full server's runMigration(packageRoot) must not import legacy repo data.
        (self.runtime / 'home/.migrated-v1').write_text(json.dumps({'isolatedProbe': True}))
        self.report['startupPaths'] = {'cwd': str(self.runtime / 'work'), 'home': str(self.runtime / 'home'),
                                       'tmpdir': str(self.runtime / 'tmp'), 'settingsPath': str(settings_file),
                                       'settingsHash': digest(settings_file.read_bytes()),
                                       'migration': 'owned home marker skips legacy packageRoot migration',
                                       'packageRootHasEnv': (ROOT / '.env').exists()}
        assert not (ROOT / '.env').exists(), 'package .env would introduce unverified startup overrides'
        self.env = dict(os.environ, CLI_JAW_HOME=str(self.runtime / 'home'), TMPDIR=str(self.runtime / 'tmp'),
                        AGENT_CLI_CREDENTIAL_STORE='keychain', TERM='xterm-256color', NO_COLOR='1',
                        PORT=str(self.port), JAW_OPEN_BROWSER='0', NODE_ENV='test',
                        JAW_CURSOR_OBSERVER=str(self.wire_path), JAW_CURSOR_MARKERS=','.join(self.markers),
                        JAW_CURSOR_TOOL_PID=str(self.tool_pid))
        # Never inherit application connection overrides, debug preloads, or provider API secrets.
        for key in list(self.env):
            if key.startswith(('SLACK_', 'TELEGRAM_', 'DISCORD_', 'JAW_AUTH_', 'CURSOR_API_')) or key in ('NODE_OPTIONS', 'CI'):
                self.env.pop(key)
        self.server_bytes = 0


    def save(self, name, value):
        (self.evidence / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


    def wire(self):
        assert self.wire_path.stat().st_size <= 2 * 1024 * 1024 + 100, 'wire capture bound'
        lines = self.wire_path.read_text().splitlines()
        rows = []
        for line in lines:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                assert line == lines[-1], 'invalid observer record'
        assert not any(r['kind'].startswith('observer-') for r in rows), 'observer capture failed'
        return rows


    def request(self, path):
        assert time.monotonic() < self.deadline, 'probe deadline'
        with urllib.request.urlopen(self.base + path, timeout=1) as response:
            raw = response.read(300000)
            assert len(raw) < 300000, 'HTTP response bound'
            data = json.loads(raw)
            return data.get('data', data)


    def sse(self):
        try:
            self.response = urllib.request.urlopen(self.base + '/api/events', timeout=155)
            self.sse_ready.set()
            total = 0
            while not self.stopping.is_set():
                line = self.response.readline(270001)
                if not line:
                    break
                total += len(line)
                assert total <= MAX_BYTES and len(line) <= 270000, 'SSE capture bound'
                if line.startswith(b'data: '):
                    event = json.loads(line[6:])
                    if event.get('event') in ('agent_runtime', 'agent_runtime_gap', 'agent_done', 'orchestrate_done', 'agent_output'):
                        self.events.append(event)
        except Exception as error:
            if not self.stopping.is_set():
                self.errors.append(type(error).__name__ + ': SSE capture failed')


    def discover(self):
        # Parent relation is checked before capturing a command fingerprint. Never persist unrelated commands.
        raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid='], timeout=1).decode()
        pairs = [tuple(map(int, line.split())) for line in raw.splitlines() if line.strip()]
        for _ in range(8):
            added = False
            for pid, parent in pairs:
                if parent in self.owned and pid in self.owned:
                    parent_now, current = process_state(parent), process_state(pid)
                    assert current['state'] != 'unknown' and parent_now['state'] != 'unknown', 'owned process identity unknown'
                    if (parent_now.get('fingerprint') == self.owned[parent].get('fingerprint')
                            and current['state'] == 'alive' and current['startedAt'] == self.owned[pid].get('startedAt')
                            and current['fingerprint'] != self.owned[pid].get('fingerprint')):
                        self.report.setdefault('ownedExecTransitions', []).append({'pid': pid, 'before': self.owned[pid], 'after': current})
                        self.owned[pid] = current
                if parent in self.owned and pid not in self.owned:
                    parent_now = process_state(parent)
                    assert parent_now['state'] != 'unknown', 'parent process identity unknown'
                    if parent_now.get('fingerprint') != self.owned[parent].get('fingerprint'):
                        continue
                    identity = process_state(pid)
                    assert identity['state'] != 'unknown', 'descendant process identity unknown'
                    if identity['state'] == 'alive':
                        self.owned[pid] = identity
                        added = True
            if not added:
                break
        if self.tool_pid and self.tool_pid.exists():
            pid = int(self.tool_pid.read_text())
            if pid not in self.owned:
                command = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'command='], timeout=.7).decode()
                assert str(self.tool) in command, 'tool PID ownership mismatch'
                identity = process_state(pid)
                assert identity['state'] == 'alive', 'tool process identity unknown'
                self.owned[pid] = identity


    def pump(self, timeout=.03):
        assert time.monotonic() < self.deadline, '150s intrinsic probe deadline'
        assert not self.errors, self.errors
        if time.monotonic() - self.last_discovery > .5:
            self.discover()
            self.last_discovery = time.monotonic()
        streams = [p.stdout for p in self.procs if p.stdout and p.poll() is None]
        if self.master is not None:
            streams.append(self.master)
        ready, _, _ = select.select(streams, [], [], timeout)
        for stream in ready:
            try:
                data = os.read(stream if isinstance(stream, int) else stream.fileno(), 65536)
            except OSError:
                data = b''
            if stream == self.master:
                self.capture.extend(data)
                assert len(self.capture) <= MAX_BYTES, 'PTY capture bound'
            else:
                # Full server logs contain a partial auth token; discard them, count only.
                self.server_bytes += len(data)
                assert self.server_bytes <= MAX_BYTES, 'server capture bound'


    def wait(self, condition, label, seconds=35):
        until = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < until:
            self.pump()
            if condition():
                return
            assert all(p.poll() is None for p in self.procs), f'process exited awaiting {label}'
        raise AssertionError(f'timeout: {label}')


    def screen(self):
        self.save('screen-input.json', {'data': base64.b64encode(self.capture).decode(),
                                       'sizes': [{'offset': 0, 'columns': 120, 'rows': ROWS}]})
        return json.loads(subprocess.check_output(['node', str(ROOT / 'tests/smoke/tui-pty-screen.mjs'),
                                                   str(self.evidence / 'screen-input.json')], cwd=ROOT, timeout=3))


    def cleanup(self):
        self.stopping.set()
        discovery_ok = True
        try:
            if self.procs:
                self.discover()
        except Exception as error:
            discovery_ok = False
            self.report['cleanupDiscoveryError'] = type(error).__name__

        def states():
            result = {}
            for pid, identity in self.owned.items():
                direct = next((p for p in self.procs if p.pid == pid), None)
                if direct and direct.poll() is not None:
                    result[pid] = {'state': 'absent', 'evidence': 'owned child reaped', 'returncode': direct.returncode}
                    continue
                current = process_state(pid)
                if (current['state'] == 'alive' and identity.get('startedAt')
                        and current['startedAt'] != identity['startedAt']):
                    current = {'state': 'absent', 'evidence': 'changed PID start identity', 'current': current}
                elif current['state'] == 'alive' and current.get('fingerprint') != identity.get('fingerprint'):
                    current = {'state': 'unknown', 'evidence': 'unproven command identity change', 'current': current}
                result[pid] = current
            return result

        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid, current in reversed(list(states().items())):
                if current['state'] == 'alive':
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
                    except OSError:
                        discovery_ok = False
            until = time.monotonic() + (3 if sig == signal.SIGTERM else 2)
            while time.monotonic() < until:
                for proc in self.procs:
                    proc.poll()
                if all(current['state'] == 'absent' for current in states().values()):
                    break
                select.select([], [], [], .05)
        if self.master is not None:
            os.close(self.master)
        if self.thread:
            self.thread.join(timeout=2)
        final_states = states()
        survivors = [pid for pid, current in final_states.items() if current['state'] == 'alive']
        unknown = [pid for pid, current in final_states.items() if current['state'] == 'unknown']
        contained = discovery_ok and not survivors and not unknown and all(p.poll() is not None for p in self.procs) and not (self.thread and self.thread.is_alive())
        if contained and self.runtime:
            shutil.rmtree(self.runtime)
        self.report['cleanup'] = {'owned': self.owned, 'survivors': survivors, 'unknown': unknown,
                                  'states': final_states, 'discoveryOk': discovery_ok, 'contained': contained,
                                  'homeRemoved': self.runtime is None or not self.runtime.exists()}
        if not contained:
            self.report['status'] = 'cleanup_failed'
        self.report['elapsedSeconds'] = round(time.monotonic() - self.started, 3)
        if self.evidence:
            self.save('events.json', self.events)
            self.save('report.json', self.report)
            (self.evidence / 'terminal.ansi').write_bytes(self.capture)
