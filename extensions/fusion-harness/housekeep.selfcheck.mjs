/**
 * Minimal self-check for housekeep pure logic.
 * Run: node --experimental-strip-types extensions/fusion-harness/housekeep.selfcheck.mjs
 * (or: bun extensions/fusion-harness/housekeep.selfcheck.mjs if bun resolves .ts imports)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	handleHousekeep,
	listRunDirs,
	parseCleanArgs,
	planClean,
	reconcileIndex,
	highValueFiles,
} from "./housekeep.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fh-selfcheck-"));
const run = (name, files = {}) => {
	const d = path.join(root, name);
	fs.mkdirSync(d);
	for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v);
	return d;
};

run("fusion-harness-a", { "summary.json": JSON.stringify({ command: "fusion", ok: true, totalCostUsd: 0.1, totalMs: 1000 }), "fused.md": "x" });
run("fusion-harness-b", { "prompt.md": "p" }); // no summary
fs.mkdirSync(path.join(root, "fusion-harness-sessions"));

const rows = reconcileIndex(root);
if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
if (listRunDirs(root).includes("fusion-harness-sessions")) throw new Error("sessions leaked");
if (!rows.find((r) => r.dir === "fusion-harness-b")) throw new Error("missing no-summary row");
if (parseCleanArgs("").keep !== 3) throw new Error("default keep");
if (parseCleanArgs("--all").keep !== 0) throw new Error("--all");
if (planClean(rows, 1).length !== 1) throw new Error("planClean");
if (!highValueFiles(path.join(root, "fusion-harness-a")).includes("fused.md")) throw new Error("hv");

const notes = [];
await handleHousekeep("", { ui: { notify: (m) => notes.push(m) } }, root);
if (!String(notes[0] || "").includes("Usage")) throw new Error("no-args should show usage");

console.log("housekeep.selfcheck: ok");
