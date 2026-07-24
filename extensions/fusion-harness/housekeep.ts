/**
 * fusion-housekeep — run index + status / archive inventory / apply / clean.
 *
 * Archive is agent-driven (not interactive slug UI):
 *   1. /fusion-housekeep archive [dir]  → inventory + agent instructions
 *   2. Agent proposes title/paths/files (using topic + repo AGENTS.md)
 *   3. User revises freely in chat
 *   4. /fusion-housekeep apply <dir> <src>=<dest> [...]  → copy + mark archived
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
/** Candidates worth preserving. fused.md is low-value merge dump — excluded. */
const HIGH_VALUE_EXACT = new Set(["gate.py"]);

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
	if (name === "fused.md") return false;
	return HIGH_VALUE_EXACT.has(name) || (name.startsWith("fused-report") && name.endsWith(".md"));
}

export function highValueFiles(runDirAbs: string): string[] {
	if (!fs.existsSync(runDirAbs)) return [];
	return fs
		.readdirSync(runDirAbs, { withFileTypes: true })
		.filter((d) => d.isFile() && isHighValueName(d.name))
		.map((d) => d.name)
		.sort();
}

/** All files in run root (for agent inventory); still labels high-value. */
export function listRunRootFiles(runDirAbs: string): { name: string; bytes: number; highValue: boolean }[] {
	if (!fs.existsSync(runDirAbs)) return [];
	return fs
		.readdirSync(runDirAbs, { withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => {
			const full = path.join(runDirAbs, d.name);
			let bytes = 0;
			try {
				bytes = fs.statSync(full).size;
			} catch {
				/* ignore */
			}
			return { name: d.name, bytes, highValue: isHighValueName(d.name) };
		})
		.sort((a, b) => Number(b.highValue) - Number(a.highValue) || a.name.localeCompare(b.name));
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
			/* skip */
		}
	}
	return rows;
}

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
	if (names.has("architect.md") && names.has("builder.md")) return "opinion";
	return undefined;
}

export function readPromptTopic(runDirAbs: string, max = 160): string | undefined {
	const p = path.join(runDirAbs, "prompt.md");
	if (!fs.existsSync(p)) return undefined;
	let text = fs.readFileSync(p, "utf-8");
	const cut = text.search(/\nFUSION INSTRUCTION:\s*\n/i);
	if (cut >= 0) text = text.slice(0, cut);
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function peekFile(runDirAbs: string, name: string, max = 280): string {
	try {
		const raw = fs.readFileSync(path.join(runDirAbs, name), "utf-8");
		const one = raw.replace(/\s+/g, " ").trim();
		return one.length > max ? `${one.slice(0, max - 1)}…` : one;
	} catch {
		return "(unreadable)";
	}
}

export function rowFromSummary(dirBasename: string, summary: Record<string, unknown> | null | undefined, runDirAbs?: string): RunIndexRow {
	const s = summary ?? {};
	const cost = typeof s.totalCostUsd === "number" ? s.totalCostUsd : undefined;
	const durationMs = typeof s.totalMs === "number" ? s.totalMs : undefined;
	const command = typeof s.command === "string" ? s.command : runDirAbs ? guessCommand(runDirAbs) : undefined;
	const ok = typeof s.ok === "boolean" ? s.ok : undefined;
	const ts = runDirAbs ? dirMtimeIso(runDirAbs) : new Date().toISOString();
	const prompt = runDirAbs ? readPromptTopic(runDirAbs) : undefined;
	return { ts, command, ok, dir: dirBasename, cost, durationMs, prompt };
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

export function reconcileIndex(artifactRoot: string): RunIndexRow[] {
	const prev = new Map(readIndex(artifactRoot).map((r) => [r.dir, r]));
	const next: RunIndexRow[] = [];
	for (const dir of listRunDirs(artifactRoot)) {
		const abs = path.join(artifactRoot, dir);
		const summary = loadSummary(abs);
		const base = rowFromSummary(dir, summary, abs);
		const old = prev.get(dir);
		if (old?.archived) base.archived = true;
		if (old?.copied?.length) base.copied = old.copied;
		if (old?.ts && (!summary || !fs.existsSync(abs))) base.ts = old.ts;
		if (!base.prompt && old?.prompt) base.prompt = old.prompt;
		next.push(base);
	}
	next.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	writeIndex(artifactRoot, next);
	return next;
}

export function upsertIndexRow(artifactRoot: string, row: RunIndexRow): void {
	const rows = readIndex(artifactRoot);
	const i = rows.findIndex((r) => r.dir === row.dir);
	if (i >= 0) {
		const prev = rows[i];
		rows[i] = { ...prev, ...row, archived: row.archived ?? prev.archived, copied: row.copied ?? prev.copied };
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

export function shortDir(dir: string): string {
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


export function listRunsPayload(rows: RunIndexRow[]): {
	index: number;
	id: string;
	shortId: string;
	command?: string;
	ok?: boolean;
	archived?: boolean;
	cost?: number;
	durationMs?: number;
	ts: string;
	topic?: string;
}[] {
	return rows.map((r, i) => ({
		index: i + 1,
		id: r.dir,
		shortId: shortDir(r.dir),
		command: r.command,
		ok: r.ok,
		archived: r.archived,
		cost: r.cost,
		durationMs: r.durationMs,
		ts: r.ts,
		topic: r.prompt,
	}));
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
		} else if (/^--keep=\d+$/.test(p)) keep = Math.floor(Number(p.slice("--keep=".length)));
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

export function resolveRun(rows: RunIndexRow[], token: string | undefined): RunIndexRow | undefined {
	if (!token) return undefined;
	const t = token.trim();
	return rows.find((r) => r.dir === t || r.dir === path.basename(t) || shortDir(r.dir) === t || r.dir.endsWith(t));
}

export function formatArchiveInventory(artifactRoot: string, run: RunIndexRow): string {
	const abs = path.join(artifactRoot, run.dir);
	const files = listRunRootFiles(abs);
	const hv = files.filter((f) => f.highValue);
	const lines: string[] = [
		`## Archive inventory · ${run.dir}`,
		`command: ${run.command ?? "?"}  ok: ${run.ok ?? "?"}  archived: ${!!run.archived}`,
		`topic: ${run.prompt ?? readPromptTopic(abs) ?? "(none)"}`,
		``,
		`### Candidate files (★ = default high-value; fused.md is NOT high-value)`,
	];
	for (const f of files) {
		const star = f.highValue ? "★" : " ";
		lines.push(`${star} ${f.name}  (${f.bytes} B)`);
		if (f.highValue || f.name === "prompt.md" || f.name.startsWith("fused-report") || f.name === "fused.md") {
			lines.push(`    peek: ${peekFile(abs, f.name)}`);
		}
	}
	if (!hv.length) {
		lines.push(``, `(no ★ candidates — agent may still archive other files via apply if user wants)`);
	}
	lines.push(
		``,
		`### For the agent`,
		`Default keep: ★ files only (not fused.md). Propose title-based dest paths from content + repo conventions.`,
		`After user confirms, call tool fusion_archive_apply (not slash re-runs).`,
	);
	return lines.join("\n");
}

/** Parse: apply <dir> src=dest src=dest ... */
export function parseApplyArgs(rest: string): { dirToken: string; maps: { from: string; to: string }[] } | { error: string } {
	const parts = rest.trim().split(/\s+/).filter(Boolean);
	if (parts.length < 2) {
		return { error: "Usage: /fusion-housekeep apply <dir> <src>=<dest> [<src>=<dest> ...]" };
	}
	const dirToken = parts[0];
	const maps: { from: string; to: string }[] = [];
	for (const p of parts.slice(1)) {
		const eq = p.indexOf("=");
		if (eq <= 0 || eq === p.length - 1) return { error: `Bad mapping (want src=dest): ${p}` };
		maps.push({ from: p.slice(0, eq), to: p.slice(eq + 1) });
	}
	return { dirToken, maps };
}

export function applyArchiveMaps(
	artifactRoot: string,
	run: RunIndexRow,
	maps: { from: string; to: string }[],
	cwd: string,
): { copied: { from: string; to: string }[]; errors: string[] } {
	const abs = path.join(artifactRoot, run.dir);
	const copied: { from: string; to: string }[] = [];
	const errors: string[] = [];
	for (const m of maps) {
		const fromAbs = path.join(abs, path.basename(m.from));
		if (!fs.existsSync(fromAbs)) {
			errors.push(`missing source: ${m.from}`);
			continue;
		}
		const toAbs = path.isAbsolute(m.to) ? m.to : path.join(cwd, m.to);
		try {
			fs.mkdirSync(path.dirname(toAbs), { recursive: true });
			fs.copyFileSync(fromAbs, toAbs);
			copied.push({ from: path.basename(m.from), to: toAbs });
		} catch (e) {
			errors.push(`${m.from}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (copied.length) {
		const all = reconcileIndex(artifactRoot);
		const r = all.find((x) => x.dir === run.dir);
		if (r) {
			r.archived = true;
			r.copied = [...(r.copied ?? []), ...copied];
			writeIndex(artifactRoot, all);
		}
	}
	return { copied, errors };
}

async function confirmYes(
	ctx: { ui: { input?: (p: string, d?: string) => Promise<string | undefined>; notify: (m: string, l?: string) => void } },
	prompt: string,
): Promise<boolean> {
	if (typeof ctx.ui.input !== "function") {
		ctx.ui.notify("fusion-housekeep: no interactive input — aborting", "warning");
		return false;
	}
	const ans = (await ctx.ui.input(prompt, "n"))?.trim().toLowerCase() ?? "n";
	return ans === "y" || ans === "yes";
}

const USAGE = [
	"Usage:",
	"  /fusion-housekeep status",
	"  /fusion-housekeep archive [dir]     — inventory for agent; no auto-copy",
	"  /fusion-housekeep apply <dir> <src>=<dest> [...]  — copy after user confirmed plan",
	"  /fusion-housekeep clean [--keep N | --all]",
].join("\n");

export async function handleHousekeep(
	rawArgs: string,
	ctx: { ui: { input?: (p: string, d?: string) => Promise<string | undefined>; notify: (m: string, l?: string) => void }; cwd?: string },
	artifactRoot: string,
): Promise<void> {
	const trimmed = (rawArgs ?? "").trim();
	const space = trimmed.indexOf(" ");
	const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

	if (!sub || !["status", "archive", "apply", "clean"].includes(sub)) {
		ctx.ui.notify(USAGE, "warning");
		return;
	}

	const rows = reconcileIndex(artifactRoot);
	const cwd = ctx.cwd ?? process.cwd();

	if (sub === "status") {
		ctx.ui.notify(formatStatus(rows), "info");
		return;
	}

	if (sub === "archive") {
		if (!rest) {
			ctx.ui.notify(
				[
					formatStatus(rows),
					``,
					`(fallback) Prefer agent workflow via /fusion-housekeep archive which injects the agent.`,
				].join("\n"),
				"info",
			);
			return;
		}
		const run = resolveRun(rows, rest);
		if (!run) {
			ctx.ui.notify(`fusion-housekeep: run not found: ${rest}`, "error");
			return;
		}
		ctx.ui.notify(formatArchiveInventory(artifactRoot, run), "info");
		return;
	}

	if (sub === "apply") {
		const parsed = parseApplyArgs(rest);
		if ("error" in parsed) {
			ctx.ui.notify(parsed.error, "warning");
			return;
		}
		const run = resolveRun(rows, parsed.dirToken);
		if (!run) {
			ctx.ui.notify(`fusion-housekeep: run not found: ${parsed.dirToken}`, "error");
			return;
		}
		const { copied, errors } = applyArchiveMaps(artifactRoot, run, parsed.maps, cwd);
		for (const c of copied) {
			ctx.ui.notify(`copied ${c.from} → ${path.relative(cwd, c.to) || c.to}`, "info");
		}
		for (const e of errors) ctx.ui.notify(`error: ${e}`, "error");
		if (copied.length) {
			ctx.ui.notify(`fusion-housekeep: ${run.dir} archived (${copied.length} file(s))`, "info");
		} else {
			ctx.ui.notify("fusion-housekeep: apply copied nothing", "warning");
		}
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
		try {
			fs.rmSync(path.join(artifactRoot, r.dir), { recursive: true, force: true });
		} catch (e) {
			ctx.ui.notify(`fusion-housekeep: failed to remove ${r.dir}: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	}
	reconcileIndex(artifactRoot);
	ctx.ui.notify(`fusion-housekeep: removed ${deleteSet.length} run(s); kept up to ${keep}`, "info");
}
