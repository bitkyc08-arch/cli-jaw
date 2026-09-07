import type { App } from 'electron';
import type { IsolatedQaPolicy } from '../../../../src/shared/isolated-qa.js';

/** Call before the single-instance lock and before any Electron session exists. */
export function applyIsolatedQaPaths(app: App, policy: IsolatedQaPolicy): void {
  app.setPath('home', policy.home);
  app.setPath('userData', policy.electron.userData);
  app.setPath('sessionData', policy.electron.sessionData);
  app.setPath('temp', policy.temporary);
  app.setPath('crashDumps', policy.electron.crashDumps);
  app.setAppLogsPath(policy.electron.logs);
}
