// Unit test for merge-source.ts pure helpers (ESM + node type-stripping).
// Run: node --experimental-strip-types extensions/fusion-harness/merge-source.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMergeExistingFlag, resolveMergeDir, loadMergeSource } from "./merge-source.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown) => { try { assert.ok(cond, name); pass++; } catch (e) { fail++; console.error("FAIL:", name, "-", (e as Error).message); } };
const eq = (name: string, a: unknown, b: unknown) => { try { assert.deepStrictEqual(a, b, name); pass++; } catch (e) { fail++; console.error("FAIL:", name, "-", (e as Error).message); } };

// ── parseMergeExistingFlag ──
eq("flag absent → null", parseMergeExistingFlag('分析 X'), null);
eq("normal quoted fusion NOT eaten", parseMergeExistingFlag('"prompt" "fusion-instr"'), null);
eq(":: form NOT eaten", parseMergeExistingFlag('prompt :: fusion-instr'), null);
eq("bare flag + unquoted dir", parseMergeExistingFlag('--merge-existing /abs/run1'), { dir: "/abs/run1", rest: "" });
eq("flag + dir + fusion instruction", parseMergeExistingFlag('--merge-existing ./run1 聚焦共识'), { dir: "./run1", rest: "聚焦共识" });
eq("flag + double-quoted dir with space", parseMergeExistingFlag('--merge-existing "/path/with space/run1" merge them'), { dir: "/path/with space/run1", rest: "merge them" });
eq("flag + single-quoted dir", parseMergeExistingFlag("--merge-existing '/rel/run2'"), { dir: "/rel/run2", rest: "" });
eq("flag anywhere in input wins", parseMergeExistingFlag('some prompt --merge-existing ./run2'), { dir: "./run2", rest: "" });

// ── resolveMergeDir ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fh-merge-"));
const cwd = tmp;
const root = path.join(tmp, "scratch", "fusion-harness");
const runDir = path.join(root, "fusion-harness-TEST01");
fs.mkdirSync(runDir, { recursive: true });
ok("absolute resolves", resolveMergeDir(runDir, cwd, root) === runDir);
ok("relative-to-cwd resolves", resolveMergeDir(path.relative(cwd, runDir), cwd, root) === runDir);
ok("bare basename resolves under ARTIFACT_ROOT", resolveMergeDir("fusion-harness-TEST01", cwd, root) === runDir);
ok("short id resolves via fusion-harness- prefix", resolveMergeDir("TEST01", cwd, root) === runDir);
ok("nonexistent absolute → null", resolveMergeDir("/no/such/dir/xyz", cwd, root) === null);
ok("nonexistent relative → null", resolveMergeDir("nope-xxx", cwd, root) === null);

// ── loadMergeSource ──
const good = path.join(root, "fusion-harness-GOOD");
fs.mkdirSync(good, { recursive: true });
fs.writeFileSync(path.join(good, "architect.md"), "architect answer body");
fs.writeFileSync(path.join(good, "builder.md"), "builder answer body");
fs.writeFileSync(path.join(good, "prompt.md"), "what is X?\n\nFUSION INSTRUCTION:\ndefault merge");
fs.writeFileSync(path.join(good, "summary.json"), JSON.stringify({ sources: [{ role: "ARCHITECT", model: "kimi/k3" }, { role: "BUILDER", model: "grok-4.5" }] }));
const loaded = loadMergeSource(good, "fallback-a", "fallback-b");
ok("good: not error", !("error" in loaded));
if (!("error" in loaded)) {
	eq("good: prompt stripped of FUSION suffix", loaded.prompt, "what is X?");
	eq("good: architect text", loaded.a.text, "architect answer body");
	eq("good: model from summary.json", loaded.a.model, "kimi/k3");
	eq("good: builder model from summary.json", loaded.b.model, "grok-4.5");
}

const missingB = path.join(root, "fusion-harness-NOB");
fs.mkdirSync(missingB, { recursive: true });
fs.writeFileSync(path.join(missingB, "architect.md"), "x");
const lb = loadMergeSource(missingB, "a", "b");
ok("missing builder.md → error", "error" in lb && /missing builder\.md/.test(lb.error));

const failA = path.join(root, "fusion-harness-FA");
fs.mkdirSync(failA, { recursive: true });
fs.writeFileSync(path.join(failA, "architect.md"), "FAILED: timeout");
fs.writeFileSync(path.join(failA, "builder.md"), "ok");
const la = loadMergeSource(failA, "a", "b");
ok("FAILED architect.md → error", "error" in la && /architect\.md is a FAILED/.test(la.error));

const noSum = path.join(root, "fusion-harness-NOSUM");
fs.mkdirSync(noSum, { recursive: true });
fs.writeFileSync(path.join(noSum, "architect.md"), "a");
fs.writeFileSync(path.join(noSum, "builder.md"), "b");
const ln = loadMergeSource(noSum, "cfg-a", "cfg-b");
if (!("error" in ln)) {
	eq("no summary → model fallback to config", ln.a.model, "cfg-a");
	eq("no summary → builder model fallback", ln.b.model, "cfg-b");
}

const opDir = path.join(root, "fusion-harness-OP");
fs.mkdirSync(opDir, { recursive: true });
fs.writeFileSync(path.join(opDir, "architect.md"), "a");
fs.writeFileSync(path.join(opDir, "builder.md"), "b");
fs.writeFileSync(path.join(opDir, "prompt.md"), "analyze SQLite vs Postgres");
const lo = loadMergeSource(opDir, "x", "y");
if (!("error" in lo)) eq("opinion prompt.md kept whole", lo.prompt, "analyze SQLite vs Postgres");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : `✗ ${fail} FAILED`} · ${pass} assertions ok`);
process.exit(fail === 0 ? 0 : 1);
