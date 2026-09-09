import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.js";
import { HookEngine } from "../src/hook-engine.js";
import { Metadata } from "../src/metadata.js";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "isolation-"));
	roots.push(root);
	const cache = await mkdtemp(join(tmpdir(), "metadata-"));
	roots.push(cache);
	vi.stubEnv("CODEX_LSP_CACHE", cache);
	await writeFile(join(root, "a.ts"), "before");
	return root;
}
it("shares touched metadata without sharing Hook findings with MCP", async () => {
	const root = await fixture();
	const hook = new HookEngine(root, async (path) => ({
		path,
		state: "complete",
		findings: [{ path, line: 1, column: 1, severity: "error", source: "lint", message: "private finding" }],
	}));
	await hook.hook({ session_id: "s", hook_event_name: "SessionStart" }, new AbortController().signal);
	await writeFile(join(root, "a.ts"), "after");
	expect(await hook.hook({ session_id: "s" }, new AbortController().signal)).toContain("LSP not executed");
	const engine = new Engine(root);
	const output = await engine.dispatch("check_diagnostics", { mode: "all" }, new AbortController().signal);
	expect(output).toContain("pending");
	expect(output).not.toContain("private finding");
	await engine.close();
});
it("atomic concurrent metadata updates preserve both touched files", async () => {
	const root = await fixture();
	const stores = [new Metadata(root), new Metadata(root)];
	await Promise.all(
		stores.map((store, i) =>
			store.update("s", new AbortController().signal, (state) => {
				state.touched.push(`${i}.ts`);
			}),
		),
	);
	expect((await stores[0]?.read("s"))?.touched.sort()).toEqual(["0.ts", "1.ts"]);
});
it("missing Hook session does not create a default session", async () => {
	const root = await fixture();
	expect(await new HookEngine(root).hook({}, new AbortController().signal)).toContain("session_id");
	expect(await new Metadata(root).ids()).toEqual([]);
});
it("requires revision on continuation and rejects changed content", async () => {
	const root = await fixture();
	const engine = new Engine(root, async (path) => ({ path, state: "complete", findings: [] }));
	const args = { mode: "full", path: "a.ts", session: "s" };
	const signal = new AbortController().signal;
	const first = await engine.dispatch("check_diagnostics", args, signal);
	const revision = /revision=([a-f0-9]+)/.exec(first)?.[1];
	expect(revision).toBeTruthy();
	await expect(engine.dispatch("check_diagnostics", { ...args, start: 1 }, signal)).rejects.toThrow("revision");
	await writeFile(join(root, "a.ts"), "changed");
	await expect(engine.dispatch("check_diagnostics", { ...args, start: 1, revision }, signal)).rejects.toThrow(
		"revision",
	);
	expect(await readFile(join(root, "a.ts"), "utf8")).toBe("changed");
	await engine.close();
});
