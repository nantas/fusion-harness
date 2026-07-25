/**
 * child-extensions.ts — resolve fusionHarness.childExtensions to `-e` entry paths.
 *
 * Extensions like pi-xai register providers dynamically at load time
 * (api.registerProvider). fusion-harness children run with --no-extensions
 * (to prevent recursive self-loading), which also excludes provider-registering
 * extensions. This module resolves a configured list of package identifiers
 * to their installed entry paths so runChild can inject them via `-e`.
 *
 * No pi/extension dependencies — only node builtins — unit-testable in isolation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Extract the package/repo name from a settings package source string. */
export function packageIdent(source: string): string {
	// git:github.com/owner/repo      → repo
	// npm:@scope/pkg                 → pkg
	// npm:pkg                        → pkg
	// file:./path/to/repo            → repo (last segment)
	const stripped = source.replace(/^(git|npm|file):/, "");
	return path.basename(stripped);
}

/** Resolve a packages source string to its install directory under agentHome. */
export function resolvePackageDir(source: string, agentHome: string): string | null {
	if (source.startsWith("git:")) {
		// git:github.com/owner/repo → <agentHome>/git/github.com/owner/repo
		return path.join(agentHome, "git", source.slice("git:".length));
	}
	if (source.startsWith("npm:")) {
		// npm:@scope/pkg or npm:pkg → <agentHome>/npm/node_modules/<pkg>
		return path.join(agentHome, "npm", "node_modules", source.slice("npm:".length));
	}
	if (source.startsWith("file:")) {
		// file:./relative or file:/abs — resolve as-is (relative to cwd at read time)
		const p = source.slice("file:".length);
		return path.isAbsolute(p) ? p : null;
	}
	return null;
}

/** Read the entry file path from an extension directory's package.json. */
export function resolveEntryPath(extDir: string): string | null {
	const pkgPath = path.join(extDir, "package.json");
	let pkg: any;
	try {
		pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
	} catch {
		return null;
	}
	// Prefer pi.extensions[0], fall back to main.
	const piExts = pkg?.pi?.extensions;
	const entry = Array.isArray(piExts) && piExts.length > 0 ? piExts[0] : pkg?.main;
	if (typeof entry !== "string" || !entry.trim()) return null;
	const entryPath = path.resolve(extDir, entry);
	return fs.existsSync(entryPath) ? entryPath : null;
}

/**
 * Merge packages from project and global settings files.
 * Returns the raw source strings (e.g. "git:github.com/nantas/pi-xai").
 */
export function readAllPackages(projectSettingsPath: string, globalSettingsPath: string): string[] {
	const read = (p: string): string[] => {
		try {
			const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
			return Array.isArray(raw?.packages) ? raw.packages : [];
		} catch {
			return [];
		}
	};
	// Deduplicate, project first (project wins on conflict, though order doesn't matter for resolution).
	const merged = [...read(projectSettingsPath), ...read(globalSettingsPath)];
	return [...new Set(merged)];
}

/**
 * Resolve a list of child extension identifiers to entry paths.
 * Silently skips identifiers not found in installed packages, whose install
 * dir doesn't exist, or whose entry can't be resolved.
 *
 * @param childExts  e.g. ["pi-xai"]
 * @param packages   raw source strings from settings (project + global merged)
 * @param agentHome  e.g. ~/.pi/agent
 * @returns          absolute entry paths suitable for `-e`
 */
export function resolveChildExtensionEntries(
	childExts: string[] | undefined,
	packages: string[],
	agentHome: string,
): string[] {
	if (!childExts || childExts.length === 0) return [];
	const result: string[] = [];
	for (const name of childExts) {
		// Find a package whose identity matches this name.
		const match = packages.find((src) => packageIdent(src) === name);
		if (!match) continue; // not installed — skip silently
		const dir = resolvePackageDir(match, agentHome);
		if (!dir || !fs.existsSync(dir)) continue;
		const entry = resolveEntryPath(dir);
		if (entry) result.push(entry);
	}
	return result;
}

/** Convenience: the default pi agent home path. */
export function defaultAgentHome(): string {
	return path.join(os.homedir(), ".pi", "agent");
}
