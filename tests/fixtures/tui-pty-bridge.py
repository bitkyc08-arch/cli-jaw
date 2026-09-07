#!/usr/bin/env python3
"""POSIX PTY mechanics only. Frames: uint32-BE length followed by UTF-8 JSON.

Launch argv is fixed at startup: NODE DIST/bin/cli-jaw.js chat --port PORT.
Input frames can only write bytes, resize, or terminate that owned child.
No shell, executable/argv command, provider, or private fixture imports.
"""
import base64
import errno
import json
import os
import select
import signal
import struct
import subprocess
import sys
import time

FRAME = 128 * 1024
STREAM = 8 * 1024 * 1024


class PtyLeaderFence:
    """One Popen lifetime, one waiter. An unreaped child reserves its PID.

    No external waiter/thread or SIGCHLD=SIG_IGN is allowed. poll/wait below
    irrevocably retire authority; signal 0 is diagnostic, never reacquisition.
    Kernel calls are injectable ONLY for controlled no-process seam tests.
    """
    def __init__(self, child, kill_group=None, kill_leader=None):
        self.child = child
        self.kill_group = kill_group if kill_group is not None else os.killpg
        self.kill_leader = kill_leader if kill_leader is not None else os.kill
        self.revoked = None
        self.unknown = False
        self.forced = []

    def revoke(self, reason):
        self.revoked = self.revoked or reason

    def owned(self):
        if self.child.returncode is not None:
            self.revoke('known-exit/reaped')
        return self.revoked is None and not self.unknown

    def poll(self):
        try:
            result = self.child.poll()
        except BaseException:
            # waitpid may already have reaped before returncode was assigned.
            self.revoke('ambiguous-poll-exit')
            self.unknown = True
            raise
        self.owned()
        return result

    def wait(self, timeout):
        try:
            return self.child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Inspected CPython _wait: an ordinary timeout follows waitpid=0;
            # successful reap records status and breaks before this raise.
            # Our signal callback cannot throw a look-alike timeout here.
            raise
        except BaseException:
            self.revoke('ambiguous-wait-exit')
            self.unknown = True
            raise
        finally:
            self.owned()

    def send(self, sig, group=True):
        if not self.owned():
            return False
        try:
            (self.kill_group if group else self.kill_leader)(self.child.pid, sig)
        except ProcessLookupError:
            self.revoke('ESRCH')
            return False
        if sig in (signal.SIGTERM, signal.SIGKILL):
            self.forced.append(signal.Signals(sig).name)
        return True

    def observe_group(self):
        self.owned()
        try:
            self.kill_group(self.child.pid, 0)
        except ProcessLookupError:
            self.revoke('ESRCH')
            return False
        # After reap/ESRCH, this could be descendants OR a recycled group.
        # Never signal it, even if it appeared before our first probe.
        if self.revoked is not None:
            self.unknown = True
        return True


def cleanup_pty_leader(fence):
    """Same fence on ordinary failure, malformed input and deadline/signal exit."""
    fence.send(signal.SIGTERM)
    try:
        fence.wait(timeout=2)
    except subprocess.TimeoutExpired:
        fence.send(signal.SIGKILL)  # only if the original leader is still unreaped
        fence.wait(timeout=2)
    group_live = fence.observe_group()  # read-only; NO post-reap escalation
    return group_live


class DeferredBridgeSignal:
    """Signal callback records only; no exception through Popen bookkeeping."""
    def __init__(self):
        self.pending = None

    def record(self, signum, _frame):
        self.pending = signum

    def check(self):
        if self.pending is not None:
            raise RuntimeError('bridge signal ' + str(self.pending))


def poll_pty_step(fence, interrupt, deadline, now=time.monotonic):
    status = fence.poll()  # complete reap/returncode/revocation before unwinding
    interrupt.check()
    if status is None and now() >= deadline:
        raise TimeoutError('bridge active deadline')
    return status


def ownership_self_test():
    """Scripted lifetime reuse, never real PID churn or OS signal delivery."""
    import unittest
    check = unittest.TestCase()
    cases = []

    class Child:
        pid = 424242

        def __init__(self, reaped=False, timeout=False):
            self.returncode = 0 if reaped else None
            self.timeout = timeout

        def poll(self):
            return self.returncode

        def wait(self, timeout):
            if self.timeout:
                self.timeout = False
                raise subprocess.TimeoutExpired('simulated-child', timeout)
            self.returncode = 0
            return 0

    for name in ('already-reaped-reused-before-first-probe', 'ESRCH-then-reappearance',
                 'owned-TERM-timeout-KILL', 'deadline-already-reaped', 'deadline-owned-timeout'):
        calls = []
        reaped = name in ('already-reaped-reused-before-first-probe', 'deadline-already-reaped')
        uncertain = reaped or name == 'ESRCH-then-reappearance'
        child = Child(reaped, timeout=not uncertain)
        missing = name == 'ESRCH-then-reappearance'

        def kernel(pid, sig):
            nonlocal missing
            calls.append([pid, int(sig)])
            if sig == 0 and (missing or not uncertain):
                missing = False
                raise ProcessLookupError(errno.ESRCH, 'simulated missing group')

        fence = PtyLeaderFence(child, kernel, kernel)
        if name == 'ESRCH-then-reappearance':
            check.assertFalse(fence.observe_group())
            check.assertTrue(fence.observe_group())
        group_live = cleanup_pty_leader(fence)
        # A later resize/deadline may never revive numeric lifetime authority.
        check.assertFalse(fence.send(signal.SIGKILL))
        check.assertFalse(fence.send(signal.SIGWINCH, group=False))
        destructive = [call for call in calls if call[1] != 0]
        check.assertEqual(destructive, [] if uncertain else [[424242, int(signal.SIGTERM)], [424242, int(signal.SIGKILL)]])
        check.assertEqual(fence.unknown, uncertain)
        check.assertEqual(group_live, uncertain)
        cases.append({'name': name, 'calls': calls, 'destructiveSignals': destructive,
                      'reaped': child.returncode is not None, 'groupLive': group_live,
                      'ownershipUnknown': fence.unknown, 'authorityRevoked': fence.revoked})
    cases.extend(interrupted_reap_cases())
    cases.extend(deferred_reap_cases())
    cases.extend(owned_timeout_cases())
    return {'passed': True, 'simulatedOnly': True, 'pythonExecutable': sys.executable,
            'pythonVersion': sys.version.split()[0], 'cases': cases}


def simulated_popen(waitpid):
    """Keep actual Popen wait/poll bookkeeping; replace only its OS wait seam."""
    import threading
    import types
    import inspect
    child = subprocess.Popen.__new__(subprocess.Popen)
    child._child_created = False  # no real child; destructor must not wait
    child.pid, child.args, child.returncode = 424242, ['simulated'], None
    child._waitpid_lock = threading.Lock()
    child._sigint_wait_secs = 0
    poll_parameters = inspect.signature(subprocess.Popen._internal_poll).parameters
    if '_waitpid' in poll_parameters:  # CPython 3.9 host bridge
        poll_args = {'_waitpid': waitpid}
    elif '_del_safe' in poll_parameters:  # CPython 3.14 installed controller Python
        poll_args = {'_del_safe': types.SimpleNamespace(waitpid=waitpid, WNOHANG=os.WNOHANG, ECHILD=errno.ECHILD)}
    else:
        raise RuntimeError('unsupported Popen poll seam; inspect this Python implementation')
    child._internal_poll = types.MethodType(
        lambda self: subprocess.Popen._internal_poll(self, **poll_args), child)
    return child


def interrupted_reap_cases():
    """Actual Popen methods; no-process objects, mocked successful OS reap."""
    import unittest
    from unittest.mock import patch
    check = unittest.TestCase()
    cases = []

    class ReapInterrupted(BaseException):
        pass

    for route in ('poll', 'wait'):
        reaped, calls = [], []

        def waitpid(pid, flags):
            reaped.append(pid)
            return pid, 0

        child = simulated_popen(waitpid)

        def interrupted_status(status):
            check.assertEqual(reaped, [424242])
            check.assertIsNone(child.returncode)
            raise ReapInterrupted('after successful reap, before returncode')

        child._handle_exitstatus = interrupted_status
        sink = lambda pid, sig: calls.append([pid, int(sig)])
        fence = PtyLeaderFence(child, sink, sink)
        with patch('subprocess.os.waitpid', side_effect=waitpid):
            with check.assertRaises(ReapInterrupted):
                fence.poll() if route == 'poll' else fence.wait(timeout=0)
        check.assertIsNone(child.returncode)  # do not hide the interrupted bookkeeping
        for sig in (signal.SIGTERM, signal.SIGKILL, signal.SIGWINCH):
            fence.send(sig, group=sig != signal.SIGWINCH)
        check.assertEqual(calls, [], route + ': interrupted reap must forbid every signal')
        check.assertTrue(fence.unknown)
        check.assertIsNotNone(fence.revoked)
        group_live = fence.observe_group()
        cases.append({'name': route + '-successful-reap-before-returncode-interruption',
                      'actualPopen': True, 'mockReaped': reaped, 'returncode': child.returncode,
                      'destructiveSignals': [], 'groupLive': group_live,
                      'ownershipUnknown': fence.unknown, 'authorityRevoked': fence.revoked})
    return cases


def deferred_reap_cases():
    """The actual installed handler returns so Popen can finish bookkeeping."""
    import unittest
    from unittest.mock import patch
    check, cases = unittest.TestCase(), []
    for route in ('poll', 'wait'):
        for sig in (signal.SIGTERM, signal.SIGINT):
            reaped, calls = [], []
            interrupt = DeferredBridgeSignal()

            def waitpid(pid, flags):
                reaped.append(pid)
                return pid, 0

            child = simulated_popen(waitpid)

            def record_status(status):
                check.assertEqual(reaped, [424242])
                check.assertIsNone(child.returncode)
                interrupt.record(sig, None)  # real callback, at the exact R2 point
                subprocess.Popen._handle_exitstatus(child, status)

            child._handle_exitstatus = record_status
            sink = lambda pid, signum: calls.append([pid, int(signum)])
            fence = PtyLeaderFence(child, sink, sink)
            with patch('subprocess.os.waitpid', side_effect=waitpid):
                with check.assertRaisesRegex(RuntimeError, 'bridge signal'):
                    if route == 'poll':
                        poll_pty_step(fence, interrupt, 100, now=lambda: 0)
                    else:
                        fence.wait(timeout=0)
                        interrupt.check()  # main's post-wait safe point
            check.assertEqual(child.returncode, 0)
            check.assertFalse(fence.unknown)
            for signum in (signal.SIGTERM, signal.SIGKILL, signal.SIGWINCH):
                check.assertFalse(fence.send(signum, group=signum != signal.SIGWINCH))
            check.assertEqual(calls, [])
            cases.append({'name': route + '-deferred-' + signal.Signals(sig).name,
                          'actualPopen': True, 'mockReaped': reaped, 'returncode': child.returncode,
                          'pendingSignal': int(interrupt.pending), 'destructiveSignals': [],
                          'ownershipUnknown': fence.unknown, 'authorityRevoked': fence.revoked})
    return cases


def owned_timeout_cases():
    """Real Popen timeout/no-reap path + same cleanup; no real sleeps/signals."""
    import itertools
    import unittest
    from unittest.mock import patch
    check, cases = unittest.TestCase(), []
    for route in ('ordinary-timeout', 'active-deadline', 'signal-before-live-poll'):
        reaped, calls, wait_results = [], [], []
        finished = False
        interrupt = DeferredBridgeSignal()

        def waitpid(pid, flags):
            result = pid if finished else 0
            wait_results.append(result)
            if finished:
                reaped.append(pid)
            return result, 0

        def kernel(pid, sig):
            nonlocal finished
            if sig == 0:
                raise ProcessLookupError(errno.ESRCH, 'simulated gone group')
            calls.append([pid, int(sig)])
            if sig == signal.SIGKILL or route == 'signal-before-live-poll':
                finished = True

        child = simulated_popen(waitpid)
        fence = PtyLeaderFence(child, kernel, kernel)
        clock = itertools.count(0, 10)  # drives genuine _wait's deadline branch
        with patch('subprocess.os.waitpid', side_effect=waitpid), patch('subprocess._time', side_effect=lambda: next(clock)):
            if route == 'ordinary-timeout':
                with check.assertRaises(subprocess.TimeoutExpired):
                    fence.wait(timeout=0)
            elif route == 'active-deadline':
                with check.assertRaisesRegex(TimeoutError, 'active deadline'):
                    poll_pty_step(fence, interrupt, 0, now=lambda: 1)
            else:
                interrupt.record(signal.SIGTERM, None)
                with check.assertRaisesRegex(RuntimeError, 'bridge signal'):
                    poll_pty_step(fence, interrupt, 100, now=lambda: 0)
            check.assertEqual(reaped, [])
            check.assertIsNone(child.returncode)
            check.assertTrue(fence.owned())  # do not conceal a live-child leak
            check.assertFalse(fence.unknown)
            group_live = cleanup_pty_leader(fence)
        expected = [[424242, int(signal.SIGTERM)]]
        if route != 'signal-before-live-poll':
            expected.append([424242, int(signal.SIGKILL)])
        check.assertEqual(calls, expected)
        check.assertEqual(reaped, [424242])
        check.assertEqual(child.returncode, 0)
        check.assertFalse(group_live)
        check.assertFalse(fence.unknown)
        cases.append({'name': 'actual-Popen-' + route + '-cleanup', 'actualPopen': True,
                      'waitResults': wait_results, 'mockReaped': reaped, 'destructiveSignals': calls,
                      'returncode': child.returncode, 'groupLive': group_live,
                      'ownershipUnknown': fence.unknown, 'authorityRevoked': fence.revoked})
    return cases


def main():
    child = None
    fence = None
    master = slave = None
    capture_bytes = 0
    command_bytes = 0
    commands = 0
    error = None
    pending = bytearray()
    outgoing = bytearray()
    initial_modes = None
    final_modes = None
    group_live = None
    deadline = time.monotonic() + 150
    interrupt = DeferredBridgeSignal()

    def frame(value):
        encoded = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode()
        if len(encoded) > FRAME or len(outgoing) + len(encoded) + 4 > 1024 * 1024:
            raise RuntimeError('bridge output queue/frame limit')
        outgoing.extend(struct.pack('!I', len(encoded)))
        outgoing.extend(encoded)

    def flush(timeout=2):
        end = time.monotonic() + timeout
        while outgoing and time.monotonic() < end:
            if select.select([], [1], [], max(0, end - time.monotonic()))[1]:
                count = os.write(1, outgoing)
                del outgoing[:count]
        if outgoing:
            raise RuntimeError('bridge output drain timeout')

    def drain():
        nonlocal capture_bytes
        while master is not None:
            try:
                data = os.read(master, 16384)
                if not data:
                    break
            except BlockingIOError:
                break
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            capture_bytes += len(data)
            if capture_bytes > STREAM:
                raise RuntimeError('PTY output limit')
            frame({'type': 'output', 'data': base64.b64encode(data).decode()})

    try:
        if os.name != 'posix':
            raise RuntimeError('unsupported host: POSIX PTY required')
        import fcntl
        import pty
        import termios
        if len(sys.argv) != 5:
            raise ValueError('usage: bridge.py ABS_NODE ABS_DIST_CLI OWNED_CWD PORT')
        node, cli, cwd, port = sys.argv[1:]
        if not os.path.isabs(node) or os.path.basename(node) != 'node' or not os.access(node, os.X_OK):
            raise ValueError('explicit Node executable required')
        if not os.path.isabs(cli) or not cli.endswith('/dist/bin/cli-jaw.js') or not os.path.isfile(cli):
            raise ValueError('compiled cli-jaw entrypoint required')
        if not os.path.isabs(cwd) or not os.path.isdir(cwd) or not os.path.basename(cwd).startswith('wp37-pty-runtime-'):
            raise ValueError('owned temporary working directory required')
        if not port.isdecimal() or not 1 <= int(port) <= 65535:
            raise ValueError('invalid fixture port')
        for key in ('HOME', 'CLI_JAW_HOME', 'TMPDIR'):
            if os.path.commonpath([cwd, os.environ.get(key, '/')]) != cwd:
                raise ValueError('uncontained ' + key)
        if 'NODE_OPTIONS' in os.environ:
            raise ValueError('preloads forbidden')
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        signal.signal(signal.SIGTERM, interrupt.record)
        signal.signal(signal.SIGINT, interrupt.record)
        # This thread is the sole waiter; an exited-but-unreaped leader keeps
        # the numeric PID reserved until fence.poll/wait explicitly revokes it.
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
        master, slave = pty.openpty()
        initial_modes = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        child = subprocess.Popen([node, cli, 'chat', '--port', port], cwd=cwd,
                                 stdin=slave, stdout=slave, stderr=slave,
                                 close_fds=True, start_new_session=True, shell=False)
        fence = PtyLeaderFence(child)
        os.set_blocking(master, False)
        frame({'type': 'ready', 'pid': child.pid, 'rows': 24, 'columns': 80})
        while poll_pty_step(fence, interrupt, deadline) is None:
            readable, writable, _ = select.select([0, master], [1] if outgoing else [], [], 0.05)
            if master in readable:
                drain()
            if 1 in writable:
                count = os.write(1, outgoing)
                del outgoing[:count]
            if 0 not in readable:
                continue
            data = os.read(0, 16384)
            if not data:
                raise RuntimeError('controller EOF before child exit')
            pending.extend(data)
            command_bytes += len(data)
            if command_bytes > STREAM or len(pending) > FRAME + 4:
                raise ValueError('command stream limit')
            while len(pending) >= 4:
                length = struct.unpack('!I', pending[:4])[0]
                if length < 2 or length > FRAME:
                    raise ValueError('invalid frame length')
                if len(pending) < length + 4:
                    break
                value = json.loads(pending[4:length + 4].decode('utf-8'))
                del pending[:length + 4]
                commands += 1
                if commands > 4096 or not isinstance(value, dict):
                    raise ValueError('command count/shape')
                kind = value.get('type')
                if kind == 'input' and set(value) == {'type', 'data'}:
                    if not isinstance(value['data'], str):
                        raise ValueError('input data type')
                    payload = base64.b64decode(value['data'], validate=True)
                    if not 1 <= len(payload) <= 16384:
                        raise ValueError('input byte limit')
                    end = time.monotonic() + 2
                    while payload:
                        if time.monotonic() >= end:
                            raise TimeoutError('PTY input write')
                        if select.select([], [master], [], 0.05)[1]:
                            count = os.write(master, payload)
                            payload = payload[count:]
                elif kind == 'resize' and set(value) == {'type', 'rows', 'columns'}:
                    rows, cols = value['rows'], value['columns']
                    if type(rows) is not int or type(cols) is not int or not 10 <= rows <= 120 or not 20 <= cols <= 240:
                        raise ValueError('resize bounds')
                    drain()  # ordered old-size output, then resize boundary, then new output
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                    observed = struct.unpack('HHHH', fcntl.ioctl(slave, termios.TIOCGWINSZ, b'\0' * 8))
                    frame({'type': 'resize', 'offset': capture_bytes, 'rows': observed[0], 'columns': observed[1]})
                    fence.send(signal.SIGWINCH, group=False)
                elif kind == 'exit' and set(value) == {'type'}:
                    raise RuntimeError('controller requested teardown')
                else:
                    raise ValueError('unknown command or fields')
        if pending:
            raise ValueError('truncated command frame at child exit')
        fence.wait(timeout=2)
        interrupt.check()
        drain()
    except BaseException as exc:
        error = type(exc).__name__ + ': ' + str(exc)
    finally:
        # Lifetime ownership, not numeric group existence, controls signalling.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if fence is not None:
            try:
                group_live = cleanup_pty_leader(fence)
                if fence.unknown:
                    error = (error or '') + '; post-reap group ownership unknown (not signalled)'
                drain()
            except BaseException as exc:
                error = (error or '') + '; cleanup: ' + str(exc)
        try:
            if slave is not None:
                final_modes = termios.tcgetattr(slave)
        except OSError as exc:
            error = (error or '') + '; termios: ' + str(exc)
        for fd in (master, slave):
            if fd is not None:
                os.close(fd)
        try:
            frame({'type': 'exit', 'pid': child.pid if child else None,
                   'code': child.returncode if child else None, 'error': error,
                   'reaped': child is not None and child.returncode is not None,
                   'groupLive': group_live, 'fdsClosed': True,
                   'ownershipUnknown': fence.unknown if fence else True,
                   'authorityRevoked': fence.revoked if fence else 'not-created',
                   'forced': fence.forced if fence else [],
                   'termiosRestored': initial_modes is not None and initial_modes == final_modes,
                   'bytes': capture_bytes, 'commands': commands})
            flush()
        except BaseException as exc:
            sys.stderr.write('bridge evidence failure: ' + str(exc) + '\n')
            error = error or str(exc)
    return 1 if error or group_live else 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--ownership-self-test']:
        print(json.dumps(ownership_self_test()))
    else:
        sys.exit(main())
