export const TITLEBAR_OVERLAY_HEIGHT = 40;
export const TITLEBAR_OVERLAY_COLOR = '#01000000';
export const TITLEBAR_DARK_SYMBOL_COLOR = '#f8fafc';
export const TITLEBAR_LIGHT_SYMBOL_COLOR = '#1f2937';
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 } as const;

export type WindowChromePlatform = 'darwin' | 'win32' | 'linux' | string;

export type WindowChromeOptions = {
  titleBarStyle: 'hiddenInset' | 'hidden';
  trafficLightPosition?: { x: number; y: number };
  titleBarOverlay?: { height: number; color: string; symbolColor: string };
};

export function resolveWindowChromeOptions(
  platform: WindowChromePlatform,
  shouldUseDarkColors: boolean,
): WindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: TRAFFIC_LIGHT_POSITION.x, y: TRAFFIC_LIGHT_POSITION.y },
    };
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      height: TITLEBAR_OVERLAY_HEIGHT,
      color: TITLEBAR_OVERLAY_COLOR,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}
