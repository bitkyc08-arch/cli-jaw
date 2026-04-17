/**
 * macOS LaunchAgent plist 생성 — 순수 함수.
 * bin/commands/launchd.ts 및 테스트에서 공유.
 */

export interface PlistOptions {
    label: string;
    port: string;
    nodePath: string;
    jawPath: string;
    jawHome: string;
    logDir: string;
    servicePath: string;
    /**
     * Optional path to Jaw.app native launcher (Contents/MacOS/jaw-launcher).
     * When present, ProgramArguments points at the launcher instead of node +
     * jaw; this preserves bundle identity for macOS TCC AppleEvents attribution.
     * The launcher itself re-execs node with the cli-jaw serve command.
     */
    jawAppPath?: string;
    /**
     * Optional pinned PATH. When present, overrides servicePath in the
     * EnvironmentVariables.PATH entry so launched children see the same PATH
     * that was baked into the native launcher.
     */
    pinnedPath?: string;
}

const xmlEsc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderProgramArguments(o: PlistOptions): string {
    if (o.jawAppPath) {
        return `    <array>
        <string>${xmlEsc(o.jawAppPath)}</string>
        <string>--home</string>
        <string>${xmlEsc(o.jawHome)}</string>
        <string>--port</string>
        <string>${xmlEsc(o.port)}</string>
    </array>`;
    }
    return `    <array>
        <string>${xmlEsc(o.nodePath)}</string>
        <string>${xmlEsc(o.jawPath)}</string>
        <string>--home</string>
        <string>${xmlEsc(o.jawHome)}</string>
        <string>serve</string>
        <string>--port</string>
        <string>${xmlEsc(o.port)}</string>
    </array>`;
}

export function generateLaunchdPlist(o: PlistOptions): string {
    const pathValue = o.pinnedPath && o.pinnedPath.length > 0 ? o.pinnedPath : o.servicePath;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEsc(o.label)}</string>
    <key>ProgramArguments</key>
${renderProgramArguments(o)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>SessionCreate</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${xmlEsc(o.jawHome)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEsc(o.logDir)}/jaw-serve.log</string>
    <key>StandardErrorPath</key>
    <string>${xmlEsc(o.logDir)}/jaw-serve.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xmlEsc(pathValue)}</string>
        <key>CLI_JAW_HOME</key>
        <string>${xmlEsc(o.jawHome)}</string>
        <key>CLI_JAW_RUNTIME</key>
        <string>launchd</string>
    </dict>
</dict>
</plist>`;
}
