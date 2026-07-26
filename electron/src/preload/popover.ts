/**
 * The reminders popover's preload.
 *
 * It is deliberately empty. The popover's renderer mounts TrayRoot without
 * DesktopBridgeProvider and reads reminders over REST fetch, so it never
 * touches window.cliJawDesktop. Until wp7b it shared the Manager preload,
 * which exposed folder writes, git operations, terminal spawn and browser
 * control to the popover's renderer — a surface it had no use for and every
 * reason not to have. Giving it an empty preload closes that surface at the
 * boundary rather than relying on the renderer not to call it.
 */
export {};
