export const CLI_JAW_ELECTRON_HEADER = 'x-cli-jaw-electron';

export interface OwnedManagerProcessState {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly killed: boolean;
}

export interface RendererRequestDetails {
  readonly url: string;
  readonly referrer: string;
  readonly resourceType: string;
  readonly webContentsId?: number;
  readonly frame?: { readonly parent: unknown | null; readonly url: string } | null;
}

export interface RendererRequestIdentityContext {
  readonly managerProcess: OwnedManagerProcessState | null;
  readonly managerOrigin: string;
  readonly mainWindowWebContentsId: number | null;
}

export function isCurrentLiveOwnedManagerGeneration<T extends OwnedManagerProcessState>(
  current: T | null,
  generation: T | null,
): boolean {
  return current !== null
    && current === generation
    && current.exitCode === null
    && current.signalCode === null
    && !current.killed;
}

export function releaseOwnedManagerGeneration<T>(current: T | null, exiting: T): T | null {
  return current === exiting ? null : current;
}

function hasOrigin(raw: string, expectedOrigin: string): boolean {
  try {
    return new URL(raw).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function shouldInjectRendererRequestIdentity(
  details: RendererRequestDetails,
  context: RendererRequestIdentityContext,
): boolean {
  return isCurrentLiveOwnedManagerGeneration(context.managerProcess, context.managerProcess)
    && context.mainWindowWebContentsId !== null
    && details.webContentsId === context.mainWindowWebContentsId
    && details.frame?.parent === null
    && details.resourceType === 'xhr'
    && hasOrigin(details.url, context.managerOrigin)
    && hasOrigin(details.frame.url, context.managerOrigin);
}

export function rendererRequestHeaders(
  input: Record<string, string>,
  token: string,
  injectIdentity: boolean,
): Record<string, string> {
  const headers = { ...input };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === CLI_JAW_ELECTRON_HEADER) delete headers[name];
  }
  if (injectIdentity && token) headers[CLI_JAW_ELECTRON_HEADER] = token;
  return headers;
}
