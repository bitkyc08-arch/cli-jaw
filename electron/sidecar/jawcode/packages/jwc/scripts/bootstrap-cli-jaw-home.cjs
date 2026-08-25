#!/usr/bin/env node
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SKILLS_REPO = "https://github.com/lidge-jun/cli-jaw-skills.git";
const CLONE_COOLDOWN_MS = 10 * 60 * 1000;
const CLONE_TIMEOUT_MS = 80_000;
// Must mirror CODEX_ACTIVE + OPENCLAW_ACTIVE in lib/mcp/skills-utils.ts.
// It drifted before: search, structured-renderers, and goal were missing, so
// the desktop app activated 27 skills where the CLI activated 30.
const BASE_AUTO_ACTIVATE = new Set([
	"jaw-pdf",
	"jaw-browser",
	"jaw-memory",
	"jaw-search",
	"jaw-screen-capture",
	"jaw-docx",
	"jaw-xlsx",
	"jaw-pptx",
	"jaw-hwp",
	"jaw-github",
	"jaw-telegram-send",
	"jaw-video",
	"jaw-pdf-vision",
	"jaw-diagram",
	"jaw-structured-renderers",
	"jaw-desktop-control",
	"jaw-goal",
]);

// Pre-jaw-* names. A legacy directory is moved aside, never deleted (it may
// hold the user's own edits), and a compatibility symlink keeps literal paths
// in a customized A-1.md working for one major version.
const LEGACY_SKILL_ALIASES = new Map(
	[
		"pdf", "browser", "memory", "search", "screen-capture", "docx", "xlsx",
		"pptx", "hwp", "github", "telegram-send", "video", "pdf-vision",
		"diagram", "structured-renderers", "desktop-control", "goal",
		"dev", "dev-architecture", "dev-backend", "dev-code-reviewer", "dev-data",
		"dev-debugging", "dev-devops", "dev-frontend", "dev-pabcd",
		"dev-scaffolding", "dev-security", "dev-testing", "dev-uiux-design",
	].map((id) => [id, "jaw-" + id]),
);
const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".turbo"]);
const IGNORED_FILES = new Set([".DS_Store"]);

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const checkOnly = args.has("--check");
const postinstall = args.has("--postinstall");
const safeMode = process.env.CI === "true" || process.env.JWC_SAFE === "1";
const disabled = process.env.JWC_SKIP_CLI_JAW_BOOTSTRAP === "1";
const packageRoot = path.join(__dirname, "..");
const targetHome = resolveCliJawHome(process.env, os.homedir());
const activeDir = path.join(targetHome, "skills");
const refDir = path.join(targetHome, "skills_ref");
const cloneMetaPath = path.join(targetHome, ".skills_clone_meta.json");

function expandHome(value, homeDir) {
	if (value === "~") return homeDir;
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homeDir, value.slice(2));
	return value;
}

function resolveCliJawHome(env = process.env, homeDir = os.homedir()) {
	const configured = env.CLI_JAW_HOME?.trim();
	const raw = configured && configured.length > 0 ? configured : path.join(homeDir, ".cli-jaw");
	return path.resolve(expandHome(raw, homeDir));
}

function status(pathValue, status) {
	return { path: pathValue, status };
}

function makeResult() {
	return {
		ok: false,
		targetHome,
		safeMode,
		postinstall,
		settings: status(path.join(targetHome, "settings.json"), "pending"),
		heartbeat: status(path.join(targetHome, "heartbeat.json"), "pending"),
		mcp: status(path.join(targetHome, "mcp.json"), "pending"),
		skills: {
			activeDir,
			refDir,
			status: "pending",
			source: "none",
			downloaded: false,
			activeCount: 0,
			refCount: 0,
			ignoredDirNames: [...IGNORED_DIRS],
		},
	};
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(filePath, content) {
	if (fs.existsSync(filePath)) return "exists";
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, content);
	return "written";
}

function readSettingsSeed() {
	const seedPath = path.join(packageRoot, "defaults", "cli-jaw", "settings.json");
	const text = fs.readFileSync(seedPath, "utf8").replaceAll("__CLI_JAW_HOME__", targetHome.replace(/\\/g, "\\\\"));
	JSON.parse(text);
	return text.endsWith("\n") ? text : `${text}\n`;
}

function ensureBaseHome(result, mode) {
	ensureDir(targetHome);
	if (mode === "home-only") {
		result.settings.status = "skipped";
		result.heartbeat.status = "skipped";
		result.mcp.status = "skipped";
		return;
	}
	ensureDir(path.join(targetHome, "uploads"));
	ensureDir(path.join(targetHome, "prompts"));
	result.settings.status = writeIfMissing(result.settings.path, readSettingsSeed());
	result.heartbeat.status = writeIfMissing(result.heartbeat.path, `${JSON.stringify({ jobs: [] }, null, "\t")}\n`);
	result.mcp.status = writeIfMissing(result.mcp.path, `${JSON.stringify({ servers: {} }, null, "\t")}\n`);
}

function readJson(filePath, fallback) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

function loadRegistry(dir) {
	return readJson(path.join(dir, "registry.json"), { skills: {} });
}

function countSkillDirs(dir) {
	try {
		// Fold alias links into what they point at. A POSIX symlink already reads as
		// non-directory, but a Windows junction can read as one, and then the legacy
		// `dev -> jaw-dev` aliases would double this count (#446). This sidecar is
		// CommonJS and cannot import lib/mcp, so the rule is repeated rather than shared.
		const seen = new Set();
		let count = 0;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!isSkillDir(entry.name)) continue;
			const full = path.join(dir, entry.name);
			let real;
			try {
				if (!fs.statSync(full).isDirectory()) continue;
				real = fs.realpathSync(full);
			} catch {
				continue;
			}
			if (seen.has(real)) continue;
			seen.add(real);
			count++;
		}
		return count;
	} catch {
		return 0;
	}
}

function isSkillDir(name) {
	return !name.startsWith(".") && !name.endsWith(".bak") && !name.endsWith("_original") && !IGNORED_DIRS.has(name);
}

function semverGt(leftValue, rightValue) {
	const left = String(leftValue ?? "").split(".").slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
	const right = String(rightValue ?? "").split(".").slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < 3; index++) {
		if (left[index] > right[index]) return true;
		if (left[index] < right[index]) return false;
	}
	return false;
}

function updateHash(hash, current, root) {
	for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		if (entry.isFile() && (IGNORED_FILES.has(entry.name) || entry.name.endsWith(".pyc"))) continue;
		if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
		const entryPath = path.join(current, entry.name);
		if (entry.isDirectory()) {
			updateHash(hash, entryPath, root);
		} else if (entry.isFile()) {
			hash.update(path.relative(root, entryPath).replace(/\\/g, "/"));
			hash.update("\0");
			hash.update(fs.readFileSync(entryPath));
			hash.update("\0");
		}
	}
}

function fingerprint(dir) {
	const hash = crypto.createHash("sha256");
	updateHash(hash, dir, dir);
	return hash.digest("hex");
}

function shouldUpdateSkill(id, src, dst, srcRegistry, dstRegistry) {
	if (!fs.existsSync(dst)) return true;
	const srcVersion = srcRegistry.skills?.[id]?.version;
	const dstVersion = dstRegistry.skills?.[id]?.version;
	if (srcVersion && (!dstVersion || semverGt(srcVersion, dstVersion))) return true;
	return fingerprint(src) !== fingerprint(dst);
}

function copyTree(src, dst) {
	ensureDir(dst);
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		if (entry.isFile() && (IGNORED_FILES.has(entry.name) || entry.name.endsWith(".pyc"))) continue;
		const srcPath = path.join(src, entry.name);
		const dstPath = path.join(dst, entry.name);
		if (entry.isDirectory()) copyTree(srcPath, dstPath);
		else if (entry.isFile()) fs.copyFileSync(srcPath, dstPath);
	}
}

function mergeRef(sourceRoot) {
	ensureDir(refDir);
	const srcRegistry = loadRegistry(sourceRoot);
	const dstRegistry = loadRegistry(refDir);
	for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const srcPath = path.join(sourceRoot, entry.name);
		const dstPath = path.join(refDir, entry.name);
		if (entry.isDirectory()) {
			if (!isSkillDir(entry.name)) continue;
			if (shouldUpdateSkill(entry.name, srcPath, dstPath, srcRegistry, dstRegistry)) {
				fs.rmSync(dstPath, { recursive: true, force: true });
				copyTree(srcPath, dstPath);
			}
		} else if (entry.isFile() && !IGNORED_FILES.has(entry.name) && !entry.name.endsWith(".pyc")) {
			fs.copyFileSync(srcPath, dstPath);
		}
	}
}

function buildAutoActivateSet() {
	const registry = loadRegistry(refDir);
	const out = new Set(BASE_AUTO_ACTIVATE);
	for (const [id, meta] of Object.entries(registry.skills ?? {})) {
		if (meta && meta.category === "orchestration") out.add(id);
	}
	return out;
}

function activateSkills() {
	const autoActivate = buildAutoActivateSet();
	const registry = loadRegistry(refDir);
	let activeCount = 0;
	for (const id of autoActivate) {
		const src = path.join(refDir, id);
		const dst = path.join(activeDir, id);
		if (!fs.existsSync(src)) continue;
		ensureDir(activeDir);
		if (shouldUpdateSkill(id, src, dst, registry, { skills: {} })) {
			fs.rmSync(dst, { recursive: true, force: true });
			copyTree(src, dst);
		}
		activeCount++;
	}
	normalizeSkillNamespace();
	return activeCount;
}

/**
 * Same two stages as lib/mcp/skills-migration.ts, in CommonJS.
 * 1. A real legacy directory is RENAMED onto its jaw-* id when that name is
 *    free, which carries an in-place user edit forward. If both ids exist the
 *    canonical copy wins and the legacy one is MOVED to
 *    backups/skills-conflicts/<stamp>/ — never deleted.
 * 2. skills/<legacy> -> jaw-<legacy> keeps literal paths in a customized
 *    A-1.md alive. Enumerators filter on isDirectory(), which is false for a
 *    symlink, so the link never registers as a second skill.
 */
// ── jaw-* namespace helpers (mirror lib/mcp/skills-migration.ts) ──

/** Resolve a link's target the way the filesystem does, relative or absolute. */
function resolveLinkTarget(linkPath) {
	const raw = fs.readlinkSync(linkPath);
	return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(path.dirname(linkPath), raw);
}

/**
 * True when the symlink at `p` is one WE created: it already aims at
 * `expectedTarget`. "Inside the tree" is not ownership — a user can point
 * skills/jaw-browser at their own skills/my-browser, and that link is theirs.
 */
function isOwnedCompatLink(p, expectedTarget) {
	try { if (!fs.lstatSync(p).isSymbolicLink()) return false; } catch { return false; }
	if (linkPointsAt(p, expectedTarget)) return true;
	try {
		return !fs.existsSync(p) && path.basename(fs.readlinkSync(p)) === path.basename(expectedTarget);
	} catch { return false; }
}

/**
 * True when the canonical path is an immovable collision. `legacyId` is passed
 * because a link aimed at the directory we are migrating (jaw-browser ->
 * browser) is ours too — leaving it strands a link whose target is moving.
 */
function canonicalIsBlocked(canonicalPath, canonicalId, legacyId) {
	let stat = null;
	// lstat, not existsSync: a dangling link still occupies the path.
	try { stat = fs.lstatSync(canonicalPath); } catch { return false; }
	if (!stat.isSymbolicLink()) return true;
	if (isOwnedCompatLink(canonicalPath, canonicalId)) return false;
	if (legacyId && linkPointsAt(canonicalPath, legacyId)) return false;
	return true;
}

/** Remove a compat link we own so a rename can land on its path. */
function clearOwnedLink(p, canonicalId, legacyId) {
	try {
		if (isOwnedCompatLink(p, canonicalId) || (legacyId && linkPointsAt(p, legacyId))) fs.unlinkSync(p);
	} catch { /* nothing there */ }
}

/** True when the link at `p` already resolves to its sibling `target`. */
function linkPointsAt(p, target) {
	try {
		if (!fs.lstatSync(p).isSymbolicLink()) return false;
		// Windows normalizes junction targets to absolute paths, so the stored
		// string cannot be compared literally without churning every pass.
		return resolveLinkTarget(p) === path.resolve(path.dirname(p), target);
	} catch { return false; }
}

function migrateRefNamespace() {
	// skills_ref/<legacy> -> skills_ref/jaw-<legacy>. Redistributable content,
	// re-synced every pass, so renaming is safe. It is also required:
	// activateSkills copies skills_ref/<id> -> skills/<id> by exact id, so a
	// legacy reference tree keeps re-creating legacy active directories.
	if (!fs.existsSync(refDir)) return;
	// A symlinked reference tree is BORROWED from another home. Migrating
	// through it writes into a home this process does not own.
	try { if (fs.lstatSync(refDir).isSymbolicLink()) return; } catch { return; }
	let backupRoot = null;
	for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
		const legacyPath = path.join(refDir, legacyId);
		let stat = null;
		try { stat = fs.lstatSync(legacyPath); } catch { continue; }
		if (stat.isSymbolicLink()) {
			// The reference tree carries no compat links; a stray one is noise
			// the detector would otherwise report pending on every run.
			try { fs.unlinkSync(legacyPath); } catch { /* leave it */ }
			continue;
		}
		if (!stat.isDirectory()) continue;
		try {
			if (!canonicalIsBlocked(path.join(refDir, canonicalId), canonicalId, legacyId)) {
				clearOwnedLink(path.join(refDir, canonicalId), canonicalId, legacyId);
				fs.renameSync(legacyPath, path.join(refDir, canonicalId));
			} else {
				if (!backupRoot) {
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					backupRoot = path.join(targetHome, "backups", "skills-conflicts", stamp);
				}
				ensureDir(backupRoot);
				fs.renameSync(legacyPath, path.join(backupRoot, "skills_ref__" + legacyId));
			}
		} catch (e) {
			console.warn(`[skills] could not migrate ref ${legacyId}: ${e.message}`);
		}
	}
}

function normalizeSkillNamespace() {
	// The reference tree first: the active tree is populated FROM it, so
	// migrating skills/ while skills_ref/ still holds legacy ids just lets the
	// next sync put the legacy directories back.
	migrateRefNamespace();
	if (!fs.existsSync(activeDir)) return;
	let backupRoot = null;
	for (const [legacyId, canonicalId] of LEGACY_SKILL_ALIASES) {
		const legacyPath = path.join(activeDir, legacyId);
		let stat = null;
		try { stat = fs.lstatSync(legacyPath); } catch { stat = null; }
		if (stat && stat.isSymbolicLink()) {
			// Resolve rather than string-compare: a Windows junction reads back
			// absolute, so a literal compare would churn the link every pass.
			if (linkPointsAt(legacyPath, canonicalId) && fs.existsSync(legacyPath)) continue;
			try { fs.unlinkSync(legacyPath); } catch { /* leave it alone */ }
		} else if (stat && stat.isDirectory()) {
			try {
				if (!canonicalIsBlocked(path.join(activeDir, canonicalId), canonicalId, legacyId)) {
					// Free canonical name: rename, so an in-place user edit is
					// carried forward instead of stranded in a backup.
					clearOwnedLink(path.join(activeDir, canonicalId), canonicalId, legacyId);
					fs.renameSync(legacyPath, path.join(activeDir, canonicalId));
					console.log(`[skills] legacy skill migrated: ${legacyId} -> ${canonicalId}`);
				} else {
					if (!backupRoot) {
						const stamp = new Date().toISOString().replace(/[:.]/g, "-");
						backupRoot = path.join(targetHome, "backups", "skills-conflicts", stamp);
					}
					ensureDir(backupRoot);
					fs.renameSync(legacyPath, path.join(backupRoot, legacyId));
					console.log(`[skills] legacy skill backed up: ${legacyId}`);
				}
			} catch (e) {
				console.warn(`[skills] could not migrate ${legacyId}: ${e.message}`);
				continue;
			}
		} else if (stat) {
			continue;
		}
		if (!fs.existsSync(path.join(activeDir, canonicalId))) continue;
		try {
			fs.symlinkSync(canonicalId, legacyPath, "junction");
		} catch (e) {
			console.warn(`[skills] compat link ${legacyId} skipped: ${e.message}`);
		}
	}
}

function readCloneMeta() {
	const meta = readJson(cloneMetaPath, null);
	return meta && typeof meta.lastAttempt === "number" && typeof meta.success === "boolean" ? meta : null;
}

function writeCloneMeta(success) {
	fs.writeFileSync(cloneMetaPath, `${JSON.stringify({ lastAttempt: Date.now(), success }, null, "\t")}\n`);
}

function cloneCooldownActive() {
	if (process.env.JWC_FORCE_CLI_JAW_SKILLS === "1" || process.env.JAW_FORCE_CLONE === "1") return false;
	const meta = readCloneMeta();
	return Boolean(meta && !meta.success && fs.existsSync(path.join(refDir, "registry.json")) && Date.now() - meta.lastAttempt < CLONE_COOLDOWN_MS);
}

function cloneSkillsRepo() {
	if (cloneCooldownActive()) return undefined;
	const repo = process.env.JWC_CLI_JAW_SKILLS_REPO || DEFAULT_SKILLS_REPO;
	const tmp = path.join(targetHome, ".skills_clone_tmp");
	fs.rmSync(tmp, { recursive: true, force: true });
	try {
		childProcess.execFileSync("git", ["clone", "--depth", "1", repo, tmp], { stdio: "ignore", timeout: CLONE_TIMEOUT_MS });
		writeCloneMeta(true);
		return tmp;
	} catch (error) {
		writeCloneMeta(false);
		throw error;
	}
}

function bootstrapSkills(result) {
	if (safeMode) {
		const hasExistingRef = fs.existsSync(path.join(refDir, "registry.json"));
		result.skills.status = "safe-skipped";
		result.skills.source = hasExistingRef ? "existing" : "none";
		if (hasExistingRef) {
			result.skills.activeCount = activateSkills();
			result.skills.refCount = countSkillDirs(refDir);
		}
		return;
	}
	const localSource = process.env.JWC_CLI_JAW_SKILLS_SOURCE_DIR;
	let sourceRoot;
	let sourceKind = "none";
	let tmpClone;
	try {
		if (localSource) {
			sourceRoot = path.resolve(expandHome(localSource, os.homedir()));
			sourceKind = "local-fixture";
		} else {
			tmpClone = cloneSkillsRepo();
			if (tmpClone) {
				sourceRoot = tmpClone;
				sourceKind = "github";
				result.skills.downloaded = true;
			}
		}
		if (sourceRoot && fs.existsSync(sourceRoot)) {
			mergeRef(sourceRoot);
			result.skills.status = "written";
			result.skills.source = sourceKind;
		} else if (fs.existsSync(path.join(refDir, "registry.json"))) {
			result.skills.status = "exists";
			result.skills.source = "existing";
		} else {
			result.skills.status = "skipped";
			result.skills.source = "none";
		}
		result.skills.activeCount = activateSkills();
		result.skills.refCount = countSkillDirs(refDir);
	} catch (error) {
		result.skills.status = postinstall ? "failed-nonfatal" : "failed";
		result.skills.error = error instanceof Error ? error.message : String(error);
		result.skills.source = fs.existsSync(path.join(refDir, "registry.json")) ? "existing" : sourceKind;
		if (result.skills.source === "existing") {
			result.skills.activeCount = activateSkills();
			result.skills.refCount = countSkillDirs(refDir);
		}
	} finally {
		if (tmpClone) fs.rmSync(tmpClone, { recursive: true, force: true });
	}
}

function checkResult(result) {
	result.settings.status = fs.existsSync(result.settings.path) ? "exists" : result.settings.status;
	result.heartbeat.status = fs.existsSync(result.heartbeat.path) ? "exists" : result.heartbeat.status;
	result.mcp.status = fs.existsSync(result.mcp.path) ? "exists" : result.mcp.status;
	result.skills.refCount = countSkillDirs(refDir);
	result.skills.activeCount = countSkillDirs(activeDir);
	if (fs.existsSync(path.join(refDir, "registry.json"))) result.skills.source = "existing";
	if (result.skills.status === "pending") result.skills.status = result.skills.refCount > 0 ? "exists" : "missing";
	result.ok = fs.existsSync(result.settings.path) && fs.existsSync(result.heartbeat.path) && fs.existsSync(result.mcp.path) && fs.existsSync(path.join(refDir, "registry.json")) && result.skills.activeCount > 0;
}

function run() {
	const result = makeResult();
	if (disabled) {
		if (!checkOnly && postinstall) ensureBaseHome(result, "home-only");
		result.skills.status = "skipped";
		result.skills.source = "none";
		if (checkOnly) {
			checkResult(result);
			result.ok = false;
			result.status = "skipped-not-ready";
		} else {
			result.ok = postinstall;
		}
		return result;
	}
	if (checkOnly) {
		checkResult(result);
		return result;
	}
	ensureBaseHome(result, "normal");
	bootstrapSkills(result);
	checkResult(result);
	if (postinstall && result.skills.status === "failed-nonfatal") result.ok = true;
	return result;
}

function printHuman(result) {
	const prefix = postinstall ? "[jwc:init]" : "jwc cli-jaw bootstrap";
	if (result.ok) {
		process.stdout.write(`${prefix} cli-jaw home ready: ${result.targetHome}\n`);
		return;
	}
	const message = result.skills.error ? ` (${result.skills.error})` : "";
	const text = `${prefix} cli-jaw home not fully ready: skills=${result.skills.status}${message}\n`;
	(postinstall ? process.stdout : process.stderr).write(text);
	if (postinstall) {
		process.stdout.write(`${prefix} remediation: run \`npm rebuild jawcode\` or \`node ${__filename} --check --json\` from the installed package.\n`);
	}
}

let result;
try {
	result = run();
} catch (error) {
	result = makeResult();
	result.ok = false;
	result.error = error instanceof Error ? error.message : String(error);
	if (postinstall) result.ok = true;
}

if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else printHuman(result);
process.exit(result.ok || postinstall ? 0 : 1);
