/**
 * merge-source.ts — pure helpers for /fusion --merge-existing.
 *
 * Reuse a prior run's two answers (architect.md + builder.md) to skip Stage 1
 * worker re-run. No pi/extension dependencies — only node builtins — so this
 * module is unit-testable in isolation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type MergeRole = "ARCHITECT" | "BUILDER";

export type MergeSource = {
	prompt: string;
	a: { role: MergeRole; model: string; text: string };
	b: { role: MergeRole; model: string; text: string };
};

export type MergeSourceError = { error: string };

/** Parse the --merge-existing flag: `/fusion --merge-existing <dir> [rest...]`. */
export function parseMergeExistingFlag(input: string): { dir: string; rest: string } | null {
	// Allow an optionally quoted dir token (paths with spaces); rest is the fusion instruction.
	const m = input.match(/--merge-existing\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
	if (!m) return null;
	const dir = m[1] ?? m[2] ?? m[3];
	const rest = input.slice((m.index ?? 0) + m[0].length).trim();
	return { dir, rest };
}

/** Resolve a merge dir: absolute (or ~), relative-to-cwd, or relative to ARTIFACT_ROOT. */
export function resolveMergeDir(rawDir: string, cwd: string, artifactRoot: string): string | null {
	const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
	if (rawDir.startsWith("/") || rawDir.startsWith("~")) {
		const abs = expand(rawDir);
		return fs.existsSync(abs) ? abs : null;
	}
	const relCwd = path.join(cwd, rawDir);
	if (fs.existsSync(relCwd)) return relCwd;
	// A bare run basename (e.g. fusion-harness-XXXX) lives under ARTIFACT_ROOT.
	const relRoot = path.join(artifactRoot, rawDir);
	if (fs.existsSync(relRoot)) return relRoot;
	// Short id (e.g. WWZXdd) — actual dir is fusion-harness-WWZXdd under ARTIFACT_ROOT.
	if (!rawDir.startsWith("fusion-harness-")) {
		const prefixed = path.join(artifactRoot, `fusion-harness-${rawDir}`);
		if (fs.existsSync(prefixed)) return prefixed;
	}
	return null;
}

/** Load + validate a prior run's two answers. Fail-fast on any defect. */
export function loadMergeSource(dir: string, aModel: string, bModel: string): MergeSource | MergeSourceError {
	const aPath = path.join(dir, "architect.md");
	const bPath = path.join(dir, "builder.md");
	if (!fs.existsSync(aPath)) return { error: `source ${path.basename(dir)} missing architect.md` };
	if (!fs.existsSync(bPath)) return { error: `source ${path.basename(dir)} missing builder.md` };
	const aText = fs.readFileSync(aPath, "utf-8");
	const bText = fs.readFileSync(bPath, "utf-8");
	if (aText.startsWith("FAILED:")) return { error: `source ${path.basename(dir)} architect.md is a FAILED output; fusion needs two successful inputs` };
	if (bText.startsWith("FAILED:")) return { error: `source ${path.basename(dir)} builder.md is a FAILED output; fusion needs two successful inputs` };
	// Recover the original request the two answers responded to (from prompt.md).
	let prompt = "";
	const promptPath = path.join(dir, "prompt.md");
	if (fs.existsSync(promptPath)) {
		const raw = fs.readFileSync(promptPath, "utf-8");
		// /fusion writes "<prompt>\n\nFUSION INSTRUCTION:\n..."; /opinion writes just the prompt.
		const cut = raw.indexOf("\n\nFUSION INSTRUCTION:");
		prompt = (cut !== -1 ? raw.slice(0, cut) : raw).trim();
	}
	// Model attribution: prefer the source run's summary.json, fall back to current config.
	let am = aModel;
	let bm = bModel;
	try {
		const s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf-8"));
		const src: Array<{ role?: string; model?: string }> = Array.isArray(s.sources) ? s.sources : Array.isArray(s.agents) ? s.agents : [];
		const find = (role: string) => src.find((x) => x?.role === role)?.model;
		if (find("ARCHITECT")) am = find("ARCHITECT")!;
		if (find("BUILDER")) bm = find("BUILDER")!;
	} catch {
		/* summary missing/unreadable — attribution falls back to current config */
	}
	return { prompt: prompt || "(original prompt not recoverable from source run)", a: { role: "ARCHITECT", model: am, text: aText }, b: { role: "BUILDER", model: bm, text: bText } };
}
