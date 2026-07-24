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
	isHighValueName,
	formatStatus,
	parseApplyArgs,
	applyArchiveMaps,
	formatArchiveInventory,
} from "./housekeep.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fh-selfcheck-"));
const run = (name, files = {}) => {
	const d = path.join(root, name);
	fs.mkdirSync(d);
	for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v);
	return d;
};

run("fusion-harness-a", {
	"summary.json": JSON.stringify({ command: "fusion", ok: true, totalCostUsd: 0.1, totalMs: 1000 }),
	"fused.md": "low value dump",
	"fused-report-x.md": "# Real report body about getting started gaps",
	"gate.py": "print(1)\n",
	"prompt.md": "请阅读 docs/getting-started.md 并对照目前仓库的最新能力",
});
run("fusion-harness-b", { "prompt.md": "p" });
fs.mkdirSync(path.join(root, "fusion-harness-sessions"));

if (isHighValueName("fused.md")) throw new Error("fused.md must not be high-value");
if (!isHighValueName("fused-report-x.md") || !isHighValueName("gate.py")) throw new Error("report/gate should be HV");

const rows = reconcileIndex(root);
if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
if (listRunDirs(root).includes("fusion-harness-sessions")) throw new Error("sessions leaked");
const hv = highValueFiles(path.join(root, "fusion-harness-a"));
if (hv.includes("fused.md") || !hv.includes("fused-report-x.md")) throw new Error("hv set wrong: " + hv);

const status = formatStatus(rows);
if (!status.includes("getting-started")) throw new Error("status missing topic");

const notes = [];
await handleHousekeep("", { ui: { notify: (m) => notes.push(m) } }, root);
if (!String(notes[0] || "").includes("Usage")) throw new Error("no-args should show usage");

notes.length = 0;
await handleHousekeep("archive fusion-harness-a", { ui: { notify: (m) => notes.push(m) } }, root);
const inv = notes.join("\n");
if (!inv.includes("Agent instructions") || !inv.includes("fused-report-x.md")) throw new Error("inventory bad");
if (inv.includes("★ fused.md")) throw new Error("fused.md should not be star");

const parsed = parseApplyArgs("fusion-harness-a fused-report-x.md=docs/plans/my-title-review.md gate.py=docs/plans/my-title-gate.py");
if ("error" in parsed) throw new Error(parsed.error);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fh-cwd-"));
const runRow = rows.find((r) => r.dir === "fusion-harness-a");
const { copied, errors } = applyArchiveMaps(root, runRow, parsed.maps, cwd);
if (errors.length) throw new Error(String(errors));
if (copied.length !== 2) throw new Error("expected 2 copies");
if (!fs.existsSync(path.join(cwd, "docs/plans/my-title-review.md"))) throw new Error("dest missing");
if (parseCleanArgs("").keep !== 3) throw new Error("default keep");
if (planClean(rows, 1).length !== 1) throw new Error("planClean");

console.log("housekeep.selfcheck: ok");
