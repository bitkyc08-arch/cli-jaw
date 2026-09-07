/**
 * Node-side `globalThis.Bun` construction (100.02 skeleton).
 *
 * Every member starts as an explicit "shim not implemented" thrower so the
 * first runtime failure names the missing API instead of crashing on
 * `Bun is undefined`. 100.03+ replaces the stubs with real Node 22
 * implementations (file/sleep → 100.03, spawn → 100.04, data core → 100.05,
 * peripherals → 100.07).
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import stripAnsi from "strip-ansi";
import { BunArchive } from "./bun-archive";
import { bunFile } from "./bun-file";
import { BunGlob } from "./bun-glob";
import { BunCryptoHasher, BunSHA256, bunHash, bunSha } from "./bun-hash";
import { BunImage } from "./bun-image";
import { bunJSONL } from "./bun-jsonl";
import { bunServe } from "./bun-serve";
import { bunSleep, bunSleepSync } from "./bun-sleep";
import { bunSpawn, bunSpawnSync } from "./bun-spawn";
import { bunStderr, bunStdin, bunStdout } from "./bun-stdio";
import { bunWrite } from "./bun-write";
import type { BunShim } from "./types";

function notImplemented(api: string): never {
	throw new Error(`Bun.${api} shim not implemented`);
}

function stubFn(api: string): (...args: unknown[]) => never {
	return () => notImplemented(api);
}

export function buildNodeBunShim(): BunShim {
	return {
		__jwcNodeShim: true,
		file: bunFile,
		write: bunWrite as BunShim["write"],
		sleep: bunSleep as BunShim["sleep"],
		sleepSync: bunSleepSync,
		spawn: bunSpawn as BunShim["spawn"],
		spawnSync: bunSpawnSync as BunShim["spawnSync"],
		hash: bunHash as unknown as BunShim["hash"],
		sha: bunSha,
		CryptoHasher: BunCryptoHasher,
		SHA256: BunSHA256,
		JSONL: bunJSONL,
		JSON5: { parse: JSON5.parse, stringify: JSON5.stringify },
		serve: bunServe as BunShim["serve"],
		stdin: bunStdin,
		stdout: bunStdout,
		stderr: bunStderr,
		stripANSI: stripAnsi,
		stringWidth: (text: string, _options?: unknown): number => {
			// ANSI-aware terminal cell width: wide CJK/emoji count 2, combining
			// marks 0 — mirrors Bun.stringWidth closely enough for layout code.
			const stripped = stripAnsi(String(text));
			let width = 0;
			for (const ch of stripped) {
				const code = ch.codePointAt(0) as number;
				if (code === 0x200d || (code >= 0x0300 && code <= 0x036f) || code === 0xfe0f) continue;
				const wide =
					(code >= 0x1100 && code <= 0x115f) ||
					(code >= 0x2e80 && code <= 0xa4cf) ||
					(code >= 0xac00 && code <= 0xd7a3) ||
					(code >= 0xf900 && code <= 0xfaff) ||
					(code >= 0xfe30 && code <= 0xfe4f) ||
					(code >= 0xff00 && code <= 0xff60) ||
					(code >= 0xffe0 && code <= 0xffe6) ||
					(code >= 0x1f300 && code <= 0x1faff) ||
					(code >= 0x20000 && code <= 0x3fffd);
				width += wide ? 2 : 1;
			}
			return width;
		},
		semver: {
			order: stubFn("semver.order") as unknown as BunShim["semver"]["order"],
			satisfies: stubFn("semver.satisfies") as unknown as BunShim["semver"]["satisfies"],
		},
		Archive: BunArchive,
		Glob: BunGlob,
		Image: BunImage,
		gc: () => {
			// no-op on Node by design (100 MOC mapping P)
		},
		plugin: () => {
			// Bun runtime-loader plugin hook (legacy-pi specifier shim). There is
			// no Node equivalent; plugin specifier rewriting is a Bun-CLI feature,
			// so registration is a no-op in the dist-node bundle (100.07).
		},
		env: process.env,
		argv: process.argv,
		version: "0.0.0-jwc-node-shim",
		main: process.argv[1] ?? "",
		resolveSync: (specifier: string, parent: string): string => {
			const require_ = createRequire(pathToFileURL(path.join(parent, "__resolve__.js")));
			return require_.resolve(specifier);
		},
		randomUUIDv7: (): string => {
			// RFC 9562 UUIDv7: 48-bit unix-ms timestamp + version/variant bits
			// over random payload — monotonic enough for session ids.
			const bytes = randomBytes(16);
			const ts = BigInt(Date.now());
			for (let i = 0; i < 6; i++) {
				bytes[5 - i] = Number((ts >> BigInt(i * 8)) & 0xffn);
			}
			bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
			bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
			const hex = bytes.toString("hex");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		},
		which: (command: string): string | null => {
			const result = bunSpawnSync(["which", command]);
			if (!result.success || !result.stdout) return null;
			const text = new TextDecoder().decode(result.stdout).trim();
			return text.length > 0 ? text : null;
		},
		nanoseconds: () => Number(process.hrtime.bigint()),
	};
}
