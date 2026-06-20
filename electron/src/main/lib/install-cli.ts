import { existsSync, symlinkSync, unlinkSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { app, dialog } from 'electron';

const CLI_BINS = ['jaw', 'jwc'] as const;

const SYMLINK_DIR: Record<string, string> = {
  darwin: '/usr/local/bin',
  linux: join(homedir(), '.local', 'bin'),
};

function getSidecarBinPath(name: string): string | null {
  const bin = join(
    process.resourcesPath,
    'server', 'bin',
    platform() === 'win32' ? `${name}.cmd` : name,
  );
  return existsSync(bin) ? bin : null;
}

function targetExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSidecarLink(target: string, src: string): boolean {
  try {
    return realpathSync(target) === realpathSync(src);
  } catch {
    return false;
  }
}

function findInstallConflicts(bins: Array<{ name: string; src: string | null }>, dir: string): string[] {
  const conflicts: string[] = [];
  for (const { name, src } of bins) {
    if (!src) continue;
    const target = join(dir, name);
    if (targetExists(target) && !isSidecarLink(target, src)) conflicts.push(target);
  }
  return conflicts;
}

export function isCliInstalled(): boolean {
  if (platform() === 'win32') return CLI_BINS.every(name => !!getSidecarBinPath(name));
  const dir = SYMLINK_DIR[platform()];
  if (!dir) return false;
  return CLI_BINS.every(name => existsSync(join(dir, name)));
}

export async function installCli(): Promise<{ ok: boolean; message: string }> {
  const plat = platform();
  const bins = CLI_BINS.map(name => ({ name, src: getSidecarBinPath(name) }));
  const missing = bins.filter(b => !b.src);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Incomplete sidecar bundle:\n${missing.map(b => `${b.name}: not found in sidecar`).join('\n')}`,
    };
  }

  if (plat === 'win32') {
    return { ok: true, message: 'CLI is available via the Windows installer PATH entry. Open a new terminal window before running "jaw" or "jwc".' };
  }

  const dir = SYMLINK_DIR[plat];
  if (!dir) return { ok: false, message: `Unsupported platform: ${plat}` };

  const conflicts = findInstallConflicts(bins, dir);
  if (conflicts.length > 0) {
    return {
      ok: false,
      message: `Existing CLI commands were not overwritten:\n${conflicts.join('\n')}\n\nRemove or rename those commands first, or keep using the existing terminal CLI. The desktop app can still run from its bundled sidecar.`,
    };
  }

  const escaped = (s: string) => s.replace(/"/g, '\\"');
  const installed: string[] = [];
  const failed: string[] = [];

  for (const { name, src } of bins) {
    if (!src) { failed.push(`${name}: not found in sidecar`); continue; }
    const target = join(dir, name);

    if (plat === 'darwin') {
      try {
        execSync(
          `osascript -e 'do shell script "ln -sf \\"${escaped(src)}\\" \\"${escaped(target)}\\"" with administrator privileges'`,
        );
        installed.push(target);
      } catch {
        failed.push(`${name}: admin permission denied`);
      }
    } else if (plat === 'linux') {
      try {
        mkdirSync(dir, { recursive: true });
        if (existsSync(target)) unlinkSync(target);
        symlinkSync(src, target);
        installed.push(target);
      } catch (err) {
        failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (installed.length === 0) {
    return { ok: false, message: `Installation failed:\n${failed.join('\n')}` };
  }
  if (failed.length > 0) {
    return { ok: false, message: `Failed to install CLI links:\n${failed.join('\n')}` };
  }

  const msg = [`Installed: ${installed.join(', ')}`];
  if (plat === 'linux') msg.push('Make sure ~/.local/bin is in your PATH.');
  msg.push('You can now run "jaw" and "jwc" in any terminal.');
  return { ok: true, message: msg.join('\n') };
}

export async function promptInstallCli(): Promise<void> {
  if (!app.isPackaged) return;
  if (isCliInstalled()) return;
  if (!getSidecarBinPath('jaw') || !getSidecarBinPath('jwc')) return;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Skip', 'Install'],
    defaultId: 0,
    title: 'Install CLI Command',
    message: 'Install "jaw" and "jwc" commands to your terminal?',
    detail: 'This creates symlinks so you can run "jaw" and "jwc" from any terminal window. Existing terminal commands are not overwritten. You can skip this; the desktop app still runs from its bundled sidecar.',
  });

  if (response === 1) {
    const result = await installCli();
    await dialog.showMessageBox({
      type: result.ok ? 'info' : 'error',
      message: result.ok ? 'CLI Installed' : 'Installation Failed',
      detail: result.message,
    });
  }
}
