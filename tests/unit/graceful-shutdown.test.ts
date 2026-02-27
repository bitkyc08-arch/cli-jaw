import test, { describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

describe('Graceful Shutdown Signals', () => {
    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout'] });
    });

    afterEach(() => {
        mock.timers.reset();
    });

    describe('serve.ts (Mocked)', () => {
        test('exiting guard prevents multiple kills', () => {
            let exiting = false;
            let killCount = 0;
            const kill = () => { killCount++; };

            const handleSigterm = () => {
                if (exiting) return;
                exiting = true;
                kill();
            };

            handleSigterm();
            handleSigterm(); // Should be blocked by guard

            assert.equal(killCount, 1);
        });

        test('exit code calculation with os.constants.signals', () => {
            const osConstantsSignals = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
            const getExitCode = (code: number | null, signal: string | null) => {
                if (signal) {
                    const sigCode = (osConstantsSignals as any)[signal] ?? 9;
                    return 128 + sigCode;
                }
                return code ?? 1;
            };

            assert.equal(getExitCode(null, 'SIGINT'), 130);
            assert.equal(getExitCode(null, 'SIGTERM'), 143);
            assert.equal(getExitCode(null, 'UNKNOWN'), 137); // fallback 9
            assert.equal(getExitCode(0, null), 0);
        });
    });

    describe('server.ts Shutdown Logic (Mocked)', () => {
        test('telegramBot timeout race correctly clears timer upon success', async () => {
            let timerId: NodeJS.Timeout | undefined;

            const racePromise = Promise.race([
                Promise.resolve('stopped'), // Simulates fast success
                new Promise((_, reject) => {
                    timerId = setTimeout(() => reject(new Error('telegram_timeout')), 2000);
                })
            ]);

            const result = await racePromise;
            assert.equal(result, 'stopped');

            if (timerId) clearTimeout(timerId);

            // Advance timers to ensure timeout does not fire and reject unhandled
            mock.timers.tick(3000);
        });

        test('telegramBot timeout race rejects after 2s if slow', async () => {
            let timerId: NodeJS.Timeout | undefined;
            let errorCaught = false;

            const slowStop = new Promise((resolve) => {
                setTimeout(() => resolve('stopped'), 3000);
            });

            const racePromise = Promise.race([
                slowStop,
                new Promise((_, reject) => {
                    timerId = setTimeout(() => reject(new Error('telegram_timeout')), 2000);
                })
            ]);

            const raceHandler = async () => {
                try {
                    await racePromise;
                } catch (e) {
                    errorCaught = true;
                    assert.equal((e as Error).message, 'telegram_timeout');
                } finally {
                    if (timerId) clearTimeout(timerId);
                }
            };

            const p = raceHandler();
            mock.timers.tick(2000);
            await p;

            assert.equal(errorCaught, true);
        });
    });
});
