#!/usr/bin/env python3
"""Opt-in compiled server/CLI OS PTY proof; requires explicit parent built-ready.

--mode tool is a separate logical run. Never a same-session steering substitute.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import signal
import sqlite3
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.error
sys.dont_write_bytecode = True
import tui_cursor_harness as harness
from tui_cursor_harness import CursorHarness, ROOT, ROWS, digest, process_state


class Probe(CursorHarness):
    def view(self, label, collapsed, terminal=False, marker=None, tool=False):
        def visible():
            screen = self.screen()
            rows = screen['rows']
            header_indices = [i for i, row in enumerate(rows) if re.match(r'^\s*[v>] Activity:', row)]
            headers = [rows[i].strip() for i in header_indices]
            if len(headers) == 1 and headers[0].startswith(('>' if collapsed else 'v') + ' Activity:'):
                if terminal and 'Stopped' not in headers[0]:
                    return False
                start = header_indices[0] + 1
                end = next((i for i in range(start, len(rows)) if re.match(r'^\s*╭─ You|^\s*grok-4\.6|^┌', rows[i])), len(rows))
                body = rows[start:end]
                if marker:
                    canonical = self.canonical_text()
                    if marker not in canonical:
                        return False
                    if not collapsed:
                        output = False
                        matched = False
                        for row in body:
                            if re.match(r'^\s{2}Output \(phase ', row):
                                output = True
                            elif row.strip() == 'Reasoning':
                                output = False
                            elif output and row.strip() == marker:
                                matched = True
                        if not matched:
                            return False
                if tool and not (any('OWNED_TOOL_STARTED' in row or 'owned-hold.mjs' in row for row in body)
                                 and any(e.get('kind') == 'tool' and e.get('status') == 'running' for e in self.events)):
                    return False
                self.save(label + '-screen.json', screen)
                return True
            return False
        self.wait(visible, label, 6)


    def canonical_text(self):
        items = {}
        for event in self.events:
            if event.get('event') == 'agent_runtime' and event.get('kind') == 'message':
                key = event['itemId']
                items[key] = (items.get(key, '') if event['operation'] == 'append' else '') + event['text']
        return '\n'.join(items.values())


    def send(self, text, label):
        # Bracketed paste avoids treating spaces/slashes as autocomplete navigation.
        os.write(self.master, b'\x1b[200~' + text.encode() + b'\x1b[201~')
        self.pump()
        os.write(self.master, b'\r')
        self.report['controls'].append({'label': label, 'at': int(time.time() * 1000), 'inputHash': digest(text.encode())})


    def streaming(self, attempt, marker):
        rows = self.wire()
        return any(r['kind'] == 'text' and r['attempt'] == attempt and marker in r['markers'] for r in rows) and not any(
            r['kind'] == 'response' and r['attempt'] == attempt for r in rows)


    def run(self):
        server = subprocess.Popen(['node', '--import', str(ROOT / 'tests/smoke/tui-cursor-observer.mjs'),
                                   str(ROOT / 'dist/server.js')], cwd=self.runtime / 'work', env=self.env,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        self.procs.append(server)
        self.owned[server.pid] = process_state(server.pid)
        assert self.owned[server.pid]['state'] == 'alive', 'server identity unavailable'

        def ready():
            try:
                return bool(self.request('/api/orchestrate/snapshot'))
            except (OSError, urllib.error.URLError):
                return False
        self.wait(ready, 'full server startup', 20)
        preload = next(row for row in self.wire() if row['kind'] == 'preload')
        assert preload['pid'] == server.pid and preload['entrypoint'] == str(ROOT / 'dist/server.js')
        assert Path(preload['cwd']).resolve() == (self.runtime / 'work').resolve()
        assert Path(preload['realHome']) == (self.runtime / 'home').resolve()
        assert preload['home'] == self.env['CLI_JAW_HOME'] and preload['tmpdir'] == self.env['TMPDIR']
        assert preload['settingsPath'] == str(self.runtime / 'home/settings.json')
        assert preload['settingsHash'] == self.report['startupPaths']['settingsHash']
        self.report['preload'] = preload
        self.report['serverArgv'] = server.args
        resolved = self.request('/api/settings')
        assert resolved['cli'] == 'cursor', 'server did not load Cursor selection'
        assert resolved['perCli']['cursor']['transport'] == 'native'
        assert resolved['perCli']['cursor']['model'] == 'grok-4.6'
        assert resolved['perCli']['cursor']['effort'] == 'medium'
        assert not resolved.get('activeOverrides', {}).get('cursor'), 'unexpected active Cursor override'
        assert resolved['workingDir'] == str(self.runtime / 'work'), 'provider cwd escaped fixture'
        assert resolved['messaging']['enabledChannels'] == [] and not resolved['memory']['enabled']
        self.report['resolvedSettings'] = {key: resolved[key] for key in ('cli', 'workingDir', 'multiSession', 'presentation')}
        self.report['resolvedSettings']['cursor'] = resolved['perCli']['cursor']
        session = self.request('/api/session')
        assert session['active_cli'] == 'cursor' and session['model'] == 'grok-4.6'
        assert session['permissions'] == 'auto' and session['effort'] == 'medium'
        assert Path(session['working_dir']).resolve() == (self.runtime / 'work').resolve()
        snapshot = self.request('/api/orchestrate/snapshot')
        assert snapshot['runtime']['busy'] is False and snapshot['orc']['state'] == 'IDLE'
        self.report['preflightSession'] = {key: session[key] for key in ('active_cli', 'model', 'permissions', 'effort', 'working_dir')}
        self.report['preflightSnapshot'] = {'orc': {'scope': snapshot['orc']['scope'], 'state': snapshot['orc']['state']},
                                            'busy': snapshot['runtime']['busy']}
        self.thread = threading.Thread(target=self.sse, daemon=True)
        self.thread.start()
        self.wait(self.sse_ready.is_set, 'SSE observer attached', 3)
        master, slave = pty.openpty()
        self.master = master
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, 120, 0, 0))
        try:
            cli = subprocess.Popen(['node', str(ROOT / 'dist/bin/cli-jaw.js'), 'chat', '--port', str(self.port)],
                                   cwd=self.runtime / 'work', env=self.env, stdin=slave, stdout=slave, stderr=slave,
                                   start_new_session=True)
        finally:
            os.close(slave)
        self.procs.append(cli)
        self.report['cliArgv'] = cli.args
        self.owned[cli.pid] = process_state(cli.pid)
        assert self.owned[cli.pid]['state'] == 'alive', 'CLI identity unavailable'
        self.wait(lambda: b'F6 history' in self.capture, 'actual PTY composer', 15)
        a, b, c = self.markers
        if self.args.mode == 'text':
            self.send(f'Use no tools or commands. First print {a} exactly, then count from 1 to 1000, one number per line. Keep counting until redirected.', 'initial PTY A')
            self.wait(lambda: self.streaming(1, a), 'A streaming')
            self.discover()
            self.view('A-default-folded', True, marker=a)
            os.write(master, b'\x0f')
            self.view('A-explicit-expanded', False, marker=a)
            os.write(master, b'\x0f')
            self.view('A-explicit-folded', True)
            self.send(f'/steer Stop previous counting. Use no tools. First repeat the original CURSOR_A marker, then print {b} exactly, then count from 1 to 1000, one number per line.', 'PTY slash steer B')
            self.wait(lambda: self.streaming(2, b), 'B streaming in same native session')
            self.view('B-preserved-folded', True, marker=b)
            os.write(master, b'\x0f')
            self.view('B-explicit-expanded', False, marker=b)
            self.send(f'Stop previous counting. Use no tools. First repeat the original CURSOR_A and CURSOR_B markers, then print {c} exactly, then count from 1 to 1000, one number per line.', 'PTY normal busy C')
            self.wait(lambda: self.streaming(3, c), 'C streaming in same native session')
            self.view('C-preserved-expanded', False, marker=c)
            assert self.streaming(3, c), 'C finished before Escape'
        else:
            self.send(f'Run only this benign command: node {self.tool}. It writes its own PID and waits 2.5 seconds. Do not run other commands or read other files. Afterward print {a} then count 1 to 1000.', 'PTY owned tool')
            self.wait(lambda: any(e.get('kind') == 'turn-start' for e in self.events), 'tool logical start')
            os.write(master, b'\x0f')
            self.wait(lambda: self.tool_pid.exists(), 'owned tool PID', 45)
            self.discover()
            self.view('tool-expanded', False, tool=True)
            self.report['toolIdentityBeforeStop'] = {'pid': int(self.tool_pid.read_text()),
                                                    **process_state(int(self.tool_pid.read_text()))}
            assert self.report['toolIdentityBeforeStop']['state'] == 'alive', 'tool already exited or unknown'
        assert not any(e.get('kind') == 'turn-end' or e.get('event') == 'agent_done' for e in self.events), 'intermediate final'
        os.write(master, b'\x1b')
        self.report['controls'].append({'label': 'actual Escape Stop', 'at': int(time.time() * 1000)})
        self.wait(lambda: any(e.get('kind') == 'turn-end' for e in self.events), 'canonical stopped terminal', 20)
        self.wait(lambda: not self.request('/api/orchestrate/snapshot')['runtime']['busy'], 'server idle', 12)
        self.view('stopped-expanded', False, terminal=True)
        self.wait(lambda: any('idle' in row.lower() for row in self.screen()['rows']), 'actual PTY idle', 6)
        self.discover()
        self.verify()


    def verify(self):
        wire = self.wire()
        prompts = [r for r in wire if r['kind'] == 'prompt']
        count = 3 if self.args.mode == 'text' else 1
        assert len(prompts) == count
        assert len({r['pid'] for r in prompts}) == len({r['nativeHash'] for r in prompts}) == 1
        assert len([r for r in wire if r['kind'] == 'spawn']) == 1
        for attempt in range(1, count + 1):
            cancel = next(r for r in wire if r['kind'] == 'cancel' and r['attempt'] == attempt)
            response = next(r for r in wire if r['kind'] == 'response' and r['attempt'] == attempt)
            assert response['stopReason'] == 'cancelled' and cancel['ordinal'] < response['ordinal']
            if attempt < count:
                assert response['ordinal'] < prompts[attempt]['ordinal']
                assert prompts[attempt]['redirectContext'] and prompts[attempt]['operational']
        if self.args.mode == 'text':
            assert not any(r['kind'] == 'tool' for r in wire), 'text probe unexpectedly used tools'
            assert set(self.markers[:2]).issubset(prompts[2]['markers']), 'replacement lost accepted A/B context'
        else:
            cancel = next(r for r in wire if r['kind'] == 'cancel')
            assert cancel['tool'] and cancel['tool']['fingerprint'] == self.report['toolIdentityBeforeStop']['fingerprint'], 'owned tool not alive at ACP cancel write'
            assert any(e.get('kind') == 'tool' and e.get('status') == 'running' for e in self.events), 'no canonical live tool Activity'
        native = [e for e in self.events if e['event'] == 'agent_runtime']
        assert native and len({e['runId'] for e in native}) == 1
        assert len([e for e in native if e['kind'] == 'turn-start']) == 1
        ends = [e for e in native if e['kind'] == 'turn-end']
        assert len(ends) == 1 and ends[0]['status'] == 'stopped'
        assert ends[0]['finalText'] is None, 'Stop partial must not become an authoritative final or empty string'
        terminals = [e for e in self.events if e['event'] == 'agent_done']
        assert len(terminals) == 1 and terminals[0]['runtimeFinality'] == 'absent'
        assert not any(e['event'] == 'agent_output' for e in self.events), 'native leaked print output'
        ident = native[0]
        assert all(e['sessionId'] == ident['sessionId'] and e['scope'] == ident['scope'] for e in native)
        assert len({e['seq'] for e in native}) == len(native)
        if self.args.mode == 'text':
            assert all(marker in self.canonical_text() for marker in self.markers), 'canonical A/B/C body missing'
        pages, journal, after, through = [], [], 0, None
        for _ in range(104):
            path = f"/api/traces/{ident['runId']}/activity?session={ident['sessionId']}&after={after}&limit=40"
            if through is not None:
                path += f'&through={through}'
            page = self.request(path)
            pages.append(page)
            assert not page['incomplete'] and page['loss'] is None
            assert page['sessionId'] == ident['sessionId'] and page['scope'] == ident['scope']
            through = page['through'] if through is None else through
            assert page['through'] == through
            journal.extend(page['events'])
            if not page['hasMore']:
                break
            assert page['nextAfter'] > after
            after = page['nextAfter']
        else:
            raise AssertionError('journal page bound')
        assert journal == [{k: v for k, v in e.items() if k not in ('event', 'topic', 'sseReplay')} for e in native], 'journal/SSE canonical mismatch'
        try:
            self.request(f"/api/traces/{ident['runId']}/activity?session=wrong-owner")
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError('journal leaked to wrong owner')
        with sqlite3.connect(f'file:{self.runtime}/home/jaw.db?mode=ro', uri=True) as db:
            owner = db.execute('SELECT session_id,scope_key FROM trace_runs WHERE id=?', (ident['runId'],)).fetchone()
            assert owner == (ident['sessionId'], ident['scope'])
            messages = db.execute('SELECT role,content FROM messages WHERE session_id=? ORDER BY id', (ident['sessionId'],)).fetchall()
        self.save('journal.json', pages)
        self.report['messageSummary'] = [{'role': role, 'chars': len(content), 'sha256': digest(content.encode())} for role, content in messages]
        self.report['proofs'] = ['one logical run/native SID/PID', 'cancelled responses precede replacements',
                                 'no intermediate final', 'canonical SSE equals owned durable journal', 'wrong owner 404',
                                 'Stop finalText null and compatibility finality absent', 'terminal Stopped/idle in actual cells']
        if self.args.mode == 'text':
            self.report['proofs'].append('PTY slash and normal busy steer preserve explicit fold then unfold choice')
        self.report['status'] = 'passed'





def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--built-ready', required=True, help='parent-confirmed currently built HEAD')
    parser.add_argument('--attempt', type=int, choices=(1, 2, 3), required=True)
    parser.add_argument('--mode', choices=('text', 'tool'), default='text')
    parser.add_argument('--repair-evidence', help='concrete prior failure and repair note for a repeat attempt')
    args = parser.parse_args()
    probe = Probe(args)
    def deadline(_signum, _frame):
        raise TimeoutError('intrinsic probe deadline')
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(151)
    try:
        probe.prepare()
        probe.run()
    except Exception as error:
        probe.report['status'] = 'failed'
        probe.report['error'] = f'{type(error).__name__}: {error}'
    finally:
        signal.alarm(28)
        try:
            probe.cleanup()
        except Exception as error:
            probe.report['status'] = 'cleanup_failed'
            probe.report['cleanup'] = {'contained': False, 'error': type(error).__name__,
                                      'homeRemoved': probe.runtime is None or not probe.runtime.exists()}
            if probe.evidence:
                probe.save('report.json', probe.report)
        signal.alarm(0)
    print(json.dumps({'report': str(probe.evidence / 'report.json') if probe.evidence else None, 'status': probe.report['status'],
                      'error': probe.report.get('error'), 'cleanup': probe.report['cleanup']}))
    return 0 if probe.report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
