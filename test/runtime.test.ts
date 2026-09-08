import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { applyTextChanges, workspacePath } from "../src/files.js";
import { TOOLS } from "../src/protocol.js";

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "codex-lsp-test-"));
	roots.push(root);
	await writeFile(join(root, "a.ts"), "broken");
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace diagnostics", () => {
	it("keeps the tool schema fixed and small", () => {
		expect(TOOLS.map((tool) => tool.name)).toEqual([
			"check_diagnostics",
			"lsp_diagnostics",
			"lsp_navigation",
			"lsp_format",
		]);
	});
	it("reuses results but invalidates dependent files and reports stale caches", async () => {
		const root = await fixture();
		let checks = 0;
		const engine = new Engine(root, async (path) => {
			checks++;
			return {
				path,
				state: "complete",
				findings: [{ path, line: 1, column: 1, severity: "error", source: "fake", message: "broken" }],
			};
		});
		await engine.check(["a.ts"], "s", "t");
		await engine.check(["a.ts"], "s", "t");
		expect(checks).toBe(1);
		await writeFile(join(root, "dependency.ts"), "changed");
		expect((await engine.cached("all", "s")).includes("stale")).toBe(true);
		await engine.check(["a.ts"], "s", "t");
		expect(checks).toBe(2);
		await engine.close();
	});
	it("deduplicates delivery without deleting findings or mixing sessions", async () => {
		const root = await fixture();
		const engine = new Engine(root, async (path) => ({
			path,
			state: "complete",
			findings: [{ path, line: 1, column: 1, severity: "warning", source: "fake", message: "warning" }],
		}));
		await engine.check(["a.ts"], "one", "t");
		expect(await engine.feedback("one")).toContain("warning");
		expect(await engine.feedback("one")).toBe("");
		expect(await engine.cached("all", "one")).toContain("warning");
		expect(await engine.cached("all", "two")).not.toContain("warning");
		await engine.close();
	});
	it("serializes concurrent checks and keeps status compact", async () => {
		const root = await fixture();
		let active = 0;
		let max = 0;
		const engine = new Engine(root, async (path) => {
			active++;
			max = Math.max(max, active);
			await new Promise((resolve) => setTimeout(resolve, 20));
			active--;
			return { path, state: "complete", findings: [] };
		});
		await Promise.all([
			engine.dispatch(
				"check_diagnostics",
				{ mode: "full", path: "a.ts", session: "s" },
				new AbortController().signal,
			),
			engine.dispatch(
				"check_diagnostics",
				{ mode: "full", path: "a.ts", session: "s" },
				new AbortController().signal,
			),
		]);
		expect(max).toBe(1);
		expect(await engine.dispatch("check_diagnostics", { mode: "status" }, new AbortController().signal)).toContain(
			"workspace=",
		);
		await engine.close();
	});
	it("does not call an incomplete diagnostic result clean", async () => {
		const root = await fixture();
		const engine = new Engine(root, async (path) => ({
			path,
			state: "pending",
			findings: [],
			note: "server has not published",
		}));
		expect(await engine.check(["a.ts"], "s", "t")).toContain("pending");
		await engine.close();
	});
});

describe("safe edits", () => {
	it("rejects workspace escapes and overlapping edits", async () => {
		const root = await fixture();
		await expect(workspacePath(root, "../escape")).rejects.toThrow();
		expect(() =>
			applyTextChanges("abc", [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "x" },
				{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "y" },
			]),
		).toThrow();
		expect(await readFile(join(root, "a.ts"), "utf8")).toBe("broken");
	});
});
