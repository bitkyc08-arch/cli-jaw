import { existsSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs';
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

export function isCliInstalled(): boolean {
  const dir = SYMLINK_DIR[platform()];
  if (!dir) return false;
  return CLI_BINS.every(name => existsSync(join(dir, name)));
}

export async function installCli(): Promise<{ ok: boolean; message: string }> {
  const plat = platform();
  const dir = SYMLINK_DIR[plat];
  if (!dir) return { ok: false, message: `Unsupported platform: ${plat}` };

  const bins = CLI_BINS.map(name => ({ name, src: getSidecarBinPath(name) }));
  const missing = bins.filter(b => !b.src);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Incomplete sidecar bundle:\n${missing.map(b => `${b.name}: not found in sidecar`).join('\n')}`,
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

  if (plat === 'win32') {
    return { ok: true, message: 'CLI is available via the installer PATH entry.' };
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
    buttons: ['Install', 'Skip'],
    defaultId: 0,
    title: 'Install CLI Command',
    message: 'Install "jaw" and "jwc" commands to your terminal?',
    detail: 'This creates symlinks so you can run "jaw" and "jwc" from any terminal window. You can always install them later from the tray menu.',
  });

  if (response === 0) {
    const result = await installCli();
    await dialog.showMessageBox({
      type: result.ok ? 'info' : 'error',
      message: result.ok ? 'CLI Installed' : 'Installation Failed',
      detail: result.message,
    });
  }
}
