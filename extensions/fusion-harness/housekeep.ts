/**
 * fusion-housekeep — run index + status/archive/clean for ARTIFACT_ROOT.
 * Pure fs helpers; command handler uses ctx.ui only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type RunIndexRow = {
	ts: string;
	command?: string;
	ok?: boolean;
	dir: string;
	cost?: number;
	durationMs?: number;
	prompt?: string;
	archived?: boolean;
	copied?: { from: string; to: string }[];
};

const SESSIONS_DIR = "fusion-harness-sessions";
const INDEX_NAME = "run-index.jsonl";
const HIGH_VALUE_NAMES = new Set(["fused.md", "gate.py"]);

export function indexPath(artifactRoot: string): string {
	return path.join(artifactRoot, INDEX_NAME);
}

export function listRunDirs(artifactRoot: string): string[] {
	if (!fs.existsSync(artifactRoot)) return [];
	return fs
		.readdirSync(artifactRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.startsWith("fusion-harness-") && d.name !== SESSIONS_DIR)
		.map((d) => d.name);
}

export function isHighValueName(name: string): boolean {
	return HIGH_VALUE_NAMES.has(name) || (name.startsWith("fused-report") && name.endsWith(".md"));
}

export function highValueFiles(runDirAbs: string): string[] {
	if (!fs.existsSync(runDirAbs)) return [];
	return fs
		.readdirSync(runDirAbs, { withFileTypes: true })
		.filter((d) => d.isFile() && isHighValueName(d.name))
		.map((d) => d.name)
		.sort();
}

export function readIndex(artifactRoot: string): RunIndexRow[] {
	const p = indexPath(artifactRoot);
	if (!fs.existsSync(p)) return [];
	const rows: RunIndexRow[] = [];
	for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const o = JSON.parse(t) as RunIndexRow;
			if (o && typeof o.dir === "string") rows.push(o);
		} catch {
			/* skip bad line */
		}
	}
	return rows;
}

/** Atomic-ish rewrite: write tmp then rename. */
export function writeIndex(artifactRoot: string, rows: RunIndexRow[]): void {
	fs.mkdirSync(artifactRoot, { recursive: true });
	const p = indexPath(artifactRoot);
	const tmp = `${p}.${process.pid}.tmp`;
	const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
	fs.writeFileSync(tmp, body, "utf-8");
	fs.renameSync(tmp, p);
}

function dirMtimeIso(runDirAbs: string): string {
	try {
		return fs.statSync(runDirAbs).mtime.toISOString();
	} catch {
		return new Date(0).toISOString();
	}
}

function guessCommand(runDirAbs: string): string | undefined {
	const names = new Set(fs.existsSync(runDirAbs) ? fs.readdirSync(runDirAbs) : []);
	if (names.has("gate.py") || names.has("validator.md")) return "auto-validate";
	if ([...names].some((n) => n === "fused.md" || n.startsWith("fused-report"))) return "fusion";
	if (names.has("architect.md") && names.has("builder.md")) return "opinion"; // or fusion mid-fail
	return undefined;
}

/** First-line topic from prompt.md; strips FUSION INSTRUCTION trailer; collapses whitespace. */
export function readPromptTopic(runDirAbs: string, max = 100): string | undefined {
	const p = path.join(runDirAbs, "prompt.md");
	if (!fs.existsSync(p)) return undefined;
	let text = fs.readFileSync(p, "utf-8");
	const cut = text.search(/\nFUSION INSTRUCTION:\s*\n/i);
	if (cut >= 0) text = text.slice(0, cut);
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function rowFromSummary(dirBasename: string, summary: Record<string, unknown> | null | undefined, runDirAbs?: string): RunIndexRow {
	const s = summary ?? {};
	const cost = typeof s.totalCostUsd === "number" ? s.totalCostUsd : undefined;
	const durationMs = typeof s.totalMs === "number" ? s.totalMs : undefined;
	const command = typeof s.command === "string" ? s.command : runDirAbs ? guessCommand(runDirAbs) : undefined;
	const ok = typeof s.ok === "boolean" ? s.ok : undefined;
	const ts = runDirAbs ? dirMtimeIso(runDirAbs) : new Date().toISOString();
	const prompt = runDirAbs ? readPromptTopic(runDirAbs) : undefined;
	return {
		ts,
		command,
		ok,
		dir: dirBasename,
		cost,
		durationMs,
		prompt,
	};
}

function loadSummary(runDirAbs: string): Record<string, unknown> | null {
	const p = path.join(runDirAbs, "summary.json");
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Scan dirs → rebuild index, preserving archived/copied from prior index. */
export function reconcileIndex(artifactRoot: string): RunIndexRow[] {
	const prev = new Map(readIndex(artifactRoot).map((r) => [r.dir, r]));
	const dirs = listRunDirs(artifactRoot);
	const next: RunIndexRow[] = [];
	for (const dir of dirs) {
		const abs = path.join(artifactRoot, dir);
		const summary = loadSummary(abs);
		const base = rowFromSummary(dir, summary, abs);
		const old = prev.get(dir);
		if (old?.archived) base.archived = true;
		if (old?.copied?.length) base.copied = old.copied;
		// Prefer fresher summary fields; keep old ts only if we have no mtime signal
		if (old?.ts && (!summary || !fs.existsSync(abs))) base.ts = old.ts;
		if (!base.prompt && old?.prompt) base.prompt = old.prompt;
		next.push(base);
	}
	// Sort newest first
	next.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	writeIndex(artifactRoot, next);
	return next;
}

/** Upsert one row by dir (dual-write from command completion). */
export function upsertIndexRow(artifactRoot: string, row: RunIndexRow): void {
	const rows = readIndex(artifactRoot);
	const i = rows.findIndex((r) => r.dir === row.dir);
	if (i >= 0) {
		const prev = rows[i];
		rows[i] = {
			...prev,
			...row,
			archived: row.archived ?? prev.archived,
			copied: row.copied ?? prev.copied,
		};
	} else {
		rows.push(row);
	}
	rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	writeIndex(artifactRoot, rows);
}

export function appendIndexFromSummary(artifactRoot: string, artifactsDirAbs: string, summary: Record<string, unknown>): void {
	const dir = path.basename(artifactsDirAbs);
	const row = rowFromSummary(dir, summary, artifactsDirAbs);
	row.ts = new Date().toISOString();
	upsertIndexRow(artifactRoot, row);
}

function shortDir(dir: string): string {
	return dir.startsWith("fusion-harness-") ? dir.slice("fusion-harness-".length) : dir;
}

export function formatStatus(rows: RunIndexRow[]): string {
	if (!rows.length) return "fusion-housekeep: no runs under .scratch/fusion-harness/";
	const lines = ["fusion-housekeep status", "─".repeat(72)];
	rows.forEach((r, i) => {
		const cmd = r.command ?? "?";
		const ok = r.ok === true ? "ok" : r.ok === false ? "FAIL" : "?";
		const arch = r.archived ? " · archived" : "";
		const cost = r.cost != null ? ` · $${r.cost.toFixed(4)}` : "";
		const dur = r.durationMs != null ? ` · ${Math.round(r.durationMs / 1000)}s` : "";
		const topic = r.prompt?.trim() || "(no prompt.md)";
		lines.push(`${i + 1}. [${cmd}] ${ok}${arch}${cost}${dur}  ·  ${shortDir(r.dir)}`);
		lines.push(`   ${topic}`);
		lines.push(`   ${r.ts}`);
	});
	return lines.join("\n");
}

export function parseCleanArgs(raw: string): { keep: number; all: boolean } {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	let keep = 3;
	let all = false;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--all") all = true;
		else if (p === "--keep" && parts[i + 1]) {
			const n = Number(parts[++i]);
			if (Number.isFinite(n) && n >= 0) keep = Math.floor(n);
		} else if (/^--keep=\d+$/.test(p)) {
			keep = Math.floor(Number(p.slice("--keep=".length)));
		}
	}
	if (all) keep = 0;
	return { keep, all };
}

export function planClean(rows: RunIndexRow[], keep: number): RunIndexRow[] {
	const sorted = [...rows].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	return sorted.slice(Math.max(0, keep));
}

export function unarchivedHighValue(artifactRoot: string, rows: RunIndexRow[]): { dir: string; files: string[] }[] {
	const out: { dir: string; files: string[] }[] = [];
	for (const r of rows) {
		if (r.archived) continue;
		const files = highValueFiles(path.join(artifactRoot, r.dir));
		if (files.length) out.push({ dir: r.dir, files });
	}
	return out;
}

/** Topic → filesystem-safe slug (keeps letters/numbers including CJK). */
export function slugFromTopic(topic: string | undefined, fallback: string, max = 48): string {
	const raw = (topic ?? "").trim();
	// Prefer a path-like token (docs/foo/bar.md → bar)
	const pathHit = raw.match(/(?:[\w.-]+\/)+[\w.-]+(?:\.[\w.-]+)?/);
	let base = pathHit ? path.basename(pathHit[0], path.extname(pathHit[0])) : raw;
	base = base
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/^-+|-+$/g, "");
	if (!base) base = fallback.replace(/[^\p{L}\p{N}]+/gu, "-") || "run";
	return base.toLowerCase();
}

/** Map high-value source names → destination basenames under a slug. */
export function archiveDestNames(files: string[], slug: string): { from: string; destName: string }[] {
	const reportNamed = files.filter((f) => f.startsWith("fused-report") && f.endsWith(".md")).sort();
	const fusedPlain = files.filter((f) => f === "fused.md");
	const gates = files.filter((f) => f === "gate.py");
	const used = new Set<string>([...reportNamed, ...fusedPlain, ...gates]);
	const other = files.filter((f) => !used.has(f));
	const out: { from: string; destName: string }[] = [];
	const primary = reportNamed[0] ?? fusedPlain[0];
	if (primary) out.push({ from: primary, destName: `${slug}.md` });
	let extra = 2;
	for (const f of reportNamed) {
		if (f === primary) continue;
		out.push({ from: f, destName: `${slug}-report${extra++}.md` });
	}
	for (const f of fusedPlain) {
		if (f === primary) continue;
		out.push({ from: f, destName: `${slug}-fused.md` });
	}
	gates.forEach((f, i) => {
		out.push({ from: f, destName: i === 0 ? `${slug}-gate.py` : `${slug}-gate${i + 1}.py` });
	});
	for (const f of other) {
		const ext = path.extname(f) || "";
		const stem = path.basename(f, ext) || "file";
		out.push({ from: f, destName: `${slug}-${stem}${ext}` });
	}
	return out;
}

function resolveArchiveTargetDir(cwd: string, input: string): string {
	const trimmed = input.trim();
	const abs = path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed);
	return abs;
}

async function confirmYes(ctx: { ui: { input?: (p: string, d?: string) => Promise<string | undefined>; notify: (m: string, l?: string) => void } }, prompt: string): Promise<boolean> {
	if (typeof ctx.ui.input !== "function") {
		ctx.ui.notify("fusion-housekeep: no interactive input — aborting destructive action", "warning");
		return false;
	}
	const ans = (await ctx.ui.input(prompt, "n"))?.trim().toLowerCase() ?? "n";
	return ans === "y" || ans === "yes";
}

async function pickRun(
	ctx: { ui: { input?: (p: string, d?: string) => Promise<string | undefined>; notify: (m: string, l?: string) => void } },
	rows: RunIndexRow[],
	argDir?: string,
): Promise<RunIndexRow | undefined> {
	if (argDir) {
		const base = path.basename(argDir);
		const hit = rows.find((r) => r.dir === base || r.dir === argDir);
		if (!hit) {
			ctx.ui.notify(`fusion-housekeep: run not found: ${argDir}`, "error");
			return undefined;
		}
		return hit;
	}
	if (!rows.length) {
		ctx.ui.notify("fusion-housekeep: no runs to archive", "warning");
		return undefined;
	}
	if (rows.length === 1) return rows[0];
	const list = rows
		.map((r, i) => {
			const topic = r.prompt?.trim() || "(no prompt)";
			const arch = r.archived ? " · archived" : "";
			return `  ${i + 1}. [${r.command ?? "?"}] ${shortDir(r.dir)}${arch}\n      ${topic}`;
		})
		.join("\n");
	ctx.ui.notify(`Select run:\n${list}`, "info");
	if (typeof ctx.ui.input !== "function") {
		ctx.ui.notify("fusion-housekeep: pass archive <dir> when input is unavailable", "warning");
		return undefined;
	}
	const ans = (await ctx.ui.input("Run number or dir basename:", "1"))?.trim() ?? "";
	const n = Number(ans);
	if (Number.isFinite(n) && n >= 1 && n <= rows.length) return rows[n - 1];
	return rows.find((r) => r.dir === ans || r.dir === path.basename(ans));
}

export async function handleHousekeep(
	rawArgs: string,
	ctx: { ui: { input?: (p: string, d?: string) => Promise<string | undefined>; notify: (m: string, l?: string) => void }; cwd?: string },
	artifactRoot: string,
): Promise<void> {
	const trimmed = (rawArgs ?? "").trim();
	const space = trimmed.indexOf(" ");
	const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

	if (!sub || !["status", "archive", "clean"].includes(sub)) {
		ctx.ui.notify(
			"Usage:\n  /fusion-housekeep status\n  /fusion-housekeep archive [dir]\n  /fusion-housekeep clean [--keep N | --all]",
			"warning",
		);
		return;
	}

	const rows = reconcileIndex(artifactRoot);

	if (sub === "status") {
		ctx.ui.notify(formatStatus(rows), "info");
		return;
	}

	if (sub === "archive") {
		const run = await pickRun(ctx, rows, rest || undefined);
		if (!run) return;
		const abs = path.join(artifactRoot, run.dir);
		const files = highValueFiles(abs);
		if (!files.length) {
			const all = reconcileIndex(artifactRoot);
			const r = all.find((x) => x.dir === run.dir);
			if (r) {
				r.archived = true;
				writeIndex(artifactRoot, all);
			}
			ctx.ui.notify(`fusion-housekeep: ${run.dir} — no high-value files; marked archived`, "info");
			return;
		}
		if (typeof ctx.ui.input !== "function") {
			ctx.ui.notify("fusion-housekeep: archive needs interactive input (or pass paths via agent later)", "warning");
			return;
		}
		const cwd = ctx.cwd ?? process.cwd();
		const topic = run.prompt ?? readPromptTopic(abs) ?? shortDir(run.dir);
		const slug = slugFromTopic(topic, shortDir(run.dir));
		const dirAns = (await ctx.ui.input(`Target folder for archive (empty=cancel):`, "docs/plans"))?.trim() ?? "";
		if (!dirAns) {
			ctx.ui.notify("fusion-housekeep: archive cancelled", "info");
			return;
		}
		const targetDir = resolveArchiveTargetDir(cwd, dirAns);
		const planned = archiveDestNames(files, slug).map(({ from, destName }) => ({
			from,
			fromAbs: path.join(abs, from),
			toAbs: path.join(targetDir, destName),
			destName,
		}));
		const preview = planned.map((p) => `  ${p.from}  →  ${path.relative(cwd, p.toAbs) || p.toAbs}`).join("\n");
		ctx.ui.notify(`Archive plan (slug: ${slug}):\n${preview}`, "info");
		const ok = await confirmYes(ctx, "Copy these files? [y/N]");
		if (!ok) {
			ctx.ui.notify("fusion-housekeep: archive cancelled", "info");
			return;
		}
		const copied: { from: string; to: string }[] = [...(run.copied ?? [])];
		try {
			fs.mkdirSync(targetDir, { recursive: true });
		} catch (e) {
			ctx.ui.notify(`fusion-housekeep: cannot create ${targetDir}: ${e instanceof Error ? e.message : String(e)}`, "error");
			return;
		}
		for (const p of planned) {
			try {
				// avoid clobber silently: if exists, append short dir id before ext
				let toAbs = p.toAbs;
				if (fs.existsSync(toAbs)) {
					const ext = path.extname(toAbs);
					const stem = toAbs.slice(0, toAbs.length - ext.length);
					toAbs = `${stem}-${shortDir(run.dir)}${ext}`;
				}
				fs.copyFileSync(p.fromAbs, toAbs);
				copied.push({ from: p.from, to: toAbs });
				ctx.ui.notify(`copied ${p.from} → ${path.relative(cwd, toAbs) || toAbs}`, "info");
			} catch (e) {
				ctx.ui.notify(`fusion-housekeep: failed ${p.from}: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		}
		const all = reconcileIndex(artifactRoot);
		const r = all.find((x) => x.dir === run.dir);
		if (r) {
			r.archived = true;
			r.copied = copied;
			r.prompt = r.prompt ?? topic;
			writeIndex(artifactRoot, all);
		}
		ctx.ui.notify(`fusion-housekeep: ${run.dir} archived (${copied.length} file(s) → ${path.relative(cwd, targetDir) || targetDir})`, "info");
		return;
	}

	// clean
	const { keep } = parseCleanArgs(rest);
	const deleteSet = planClean(rows, keep);
	if (!deleteSet.length) {
		ctx.ui.notify(`fusion-housekeep: nothing to clean (keep ${keep}, have ${rows.length})`, "info");
		return;
	}
	const danger = unarchivedHighValue(artifactRoot, deleteSet);
	if (danger.length) {
		const list = danger.map((d) => `  ${d.dir}: ${d.files.join(", ")}`).join("\n");
		ctx.ui.notify(`High-value unarchived files in delete set:\n${list}`, "warning");
		const ok = await confirmYes(ctx, `Delete ${deleteSet.length} run(s) including the above? [y/N]`);
		if (!ok) {
			ctx.ui.notify("fusion-housekeep: clean aborted", "info");
			return;
		}
	} else {
		const ok = await confirmYes(ctx, `Delete ${deleteSet.length} run dir(s) (keep ${keep})? [y/N]`);
		if (!ok) {
			ctx.ui.notify("fusion-housekeep: clean aborted", "info");
			return;
		}
	}

	for (const r of deleteSet) {
		const abs = path.join(artifactRoot, r.dir);
		try {
			fs.rmSync(abs, { recursive: true, force: true });
		} catch (e) {
			ctx.ui.notify(`fusion-housekeep: failed to remove ${r.dir}: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	}
	reconcileIndex(artifactRoot);
	ctx.ui.notify(`fusion-housekeep: removed ${deleteSet.length} run(s); kept up to ${keep}`, "info");
}
