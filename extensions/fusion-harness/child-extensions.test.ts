// Unit test for child-extensions.ts pure helpers (ESM + node type-stripping).
// Run: node --experimental-strip-types extensions/fusion-harness/child-extensions.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	packageIdent,
	resolvePackageDir,
	resolveEntryPath,
	readAllPackages,
	resolveChildExtensionEntries,
	defaultAgentHome,
} from "./child-extensions.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown) => { try { assert.ok(cond, name); pass++; } catch (e) { fail++; console.error("FAIL:", name, "-", (e as Error).message); } };
const eq = (name: string, a: unknown, b: unknown) => { try { assert.deepStrictEqual(a, b, name); pass++; } catch (e) { fail++; console.error("FAIL:", name, "-", (e as Error).message); } };

// ── packageIdent ──
eq("git source → repo name", packageIdent("git:github.com/nantas/pi-xai"), "pi-xai");
eq("npm scoped → pkg name", packageIdent("npm:@ff-labs/pi-fff"), "pi-fff");
eq("npm bare → pkg name", packageIdent("npm:pi-mcp-adapter"), "pi-mcp-adapter");
eq("file source → basename", packageIdent("file:./local/ext"), "ext");

// ── resolvePackageDir ──
const home = "/fake/agent";
eq("git → agentHome/git/...", resolvePackageDir("git:github.com/nantas/pi-xai", home), "/fake/agent/git/github.com/nantas/pi-xai");
eq("npm scoped → agentHome/npm/node_modules/@scope/pkg", resolvePackageDir("npm:@ff-labs/pi-fff", home), "/fake/agent/npm/node_modules/@ff-labs/pi-fff");
eq("npm bare → agentHome/npm/node_modules/pkg", resolvePackageDir("npm:pi-mcp-adapter", home), "/fake/agent/npm/node_modules/pi-mcp-adapter");
eq("unknown prefix → null", resolvePackageDir("weird:thing", home), null);

// ── resolveEntryPath (synthetic ext dirs) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fh-childext-"));
// good: pi.extensions[0]
const extPiXai = path.join(tmp, "pi-xai");
fs.mkdirSync(extPiXai);
fs.writeFileSync(path.join(extPiXai, "package.json"), JSON.stringify({ main: "./lib.js", pi: { extensions: ["./index.ts"] } }));
fs.writeFileSync(path.join(extPiXai, "index.ts"), "// entry");
ok("pi.extensions[0] preferred over main", resolveEntryPath(extPiXai)?.endsWith("pi-xai/index.ts"));

// fallback: main only
const extMain = path.join(tmp, "main-only");
fs.mkdirSync(path.join(extMain, "src"), { recursive: true });
fs.writeFileSync(path.join(extMain, "package.json"), JSON.stringify({ main: "./src/start.ts" }));
fs.writeFileSync(path.join(extMain, "src", "start.ts"), "// entry");
ok("main fallback works", resolveEntryPath(extMain)?.endsWith("main-only/src/start.ts"));

// bad: no package.json
const extNoPkg = path.join(tmp, "no-pkg");
fs.mkdirSync(extNoPkg);
eq("missing package.json → null", resolveEntryPath(extNoPkg), null);

// bad: entry doesn't exist
const extNoEntry = path.join(tmp, "no-entry");
fs.mkdirSync(extNoEntry);
fs.writeFileSync(path.join(extNoEntry, "package.json"), JSON.stringify({ main: "./missing.js" }));
eq("entry not on disk → null", resolveEntryPath(extNoEntry), null);

// ── readAllPackages (synthetic settings) ──
const projSettings = path.join(tmp, "project-settings.json");
const globalSettings = path.join(tmp, "global-settings.json");
fs.writeFileSync(projSettings, JSON.stringify({ packages: ["git:github.com/nantas/pi-xai", "npm:local-pkg"] }));
fs.writeFileSync(globalSettings, JSON.stringify({ packages: ["git:github.com/nantas/fusion-harness", "git:github.com/nantas/pi-xai"] }));
eq("merge + dedup packages", readAllPackages(projSettings, globalSettings), ["git:github.com/nantas/pi-xai", "npm:local-pkg", "git:github.com/nantas/fusion-harness"]);
eq("missing settings file → []", readAllPackages(path.join(tmp, "nope.json"), path.join(tmp, "nope2.json")), []);

// ── resolveChildExtensionEntries (integration of above) ──
const agentHome = tmp; // use tmp as fake agent home
// simulate installed pi-xai under agentHome/git/...
const fakeGitDir = path.join(agentHome, "git", "github.com", "nantas", "pi-xai");
fs.mkdirSync(fakeGitDir, { recursive: true });
fs.writeFileSync(path.join(fakeGitDir, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
fs.writeFileSync(path.join(fakeGitDir, "index.ts"), "// entry");

const pkgs = ["git:github.com/nantas/pi-xai", "git:github.com/nantas/fusion-harness"];
const resolved = resolveChildExtensionEntries(["pi-xai"], pkgs, agentHome);
eq("resolve pi-xai → entry path", resolved.length, 1);
ok("resolved path is absolute + correct", resolved[0] === path.join(fakeGitDir, "index.ts"));

// not installed → skip
eq("uninstalled ext skipped", resolveChildExtensionEntries(["nonexistent-pkg"], pkgs, agentHome), []);

// empty/undefined → []
eq("undefined → []", resolveChildExtensionEntries(undefined, pkgs, agentHome), []);
eq("empty → []", resolveChildExtensionEntries([], pkgs, agentHome), []);

// multiple, one missing one present
const multi = resolveChildExtensionEntries(["pi-xai", "ghost"], pkgs, agentHome);
eq("mixed: only installed resolved", multi.length, 1);

// ── defaultAgentHome ──
ok("defaultAgentHome ends with .pi/agent", defaultAgentHome().endsWith(".pi/agent"));

console.log(`\n${fail === 0 ? "✓ ALL PASS" : `✗ ${fail} FAILED`} · ${pass} assertions ok`);
process.exit(fail === 0 ? 0 : 1);
