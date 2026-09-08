import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "codex-lsp-hook-"));
	roots.push(root);
	await writeFile(join(root, "clean.ts"), "export const value = 1;\n");
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("inventory-based PostToolUse hook", () => {
	it("does not lose changes when another PreToolUse runs before feedback", async () => {
		const root = await fixture();
		const checked: string[] = [];
		const engine = new Engine(root, async (path) => {
			checked.push(path);
			return { path, state: "complete", findings: [] };
		});
		const signal = new AbortController().signal;
		await engine.hook({ session_id: "s", hook_event_name: "SessionStart" }, signal);
		await writeFile(join(root, "changed.ts"), "changed");
		await engine.hook({ session_id: "s", hook_event_name: "PreToolUse" }, signal);
		await engine.hook({ session_id: "s", hook_event_name: "PostToolUse" }, signal);
		expect(checked).toContain("changed.ts");
		await engine.close();
	});
	it("uses the actual Stop output schema and never creates a continuation loop", async () => {
		const root = await fixture();
		const engine = new Engine(root, async (path) => ({
			path,
			state: "complete",
			findings: [{ path, line: 1, column: 1, severity: "error", source: "fake", message: "broken" }],
		}));
		const signal = new AbortController().signal;
		await engine.hook({ session_id: "s", hook_event_name: "SessionStart" }, signal);
		await writeFile(join(root, "changed.ts"), "changed");
		const output = JSON.parse(await engine.hook({ session_id: "s", hook_event_name: "Stop" }, signal));
		expect(output.decision).toBe("block");
		expect(output.reason).toContain("broken");
		expect(output.hookSpecificOutput).toBeUndefined();
		expect(await engine.hook({ session_id: "s", hook_event_name: "Stop", stop_hook_active: true }, signal)).toBe("");
		await engine.close();
	});
	it("adopts the first snapshot as baseline without scanning the whole tree", async () => {
		const root = await fixture();
		let checks = 0;
		const engine = new Engine(root, async (path) => {
			checks++;
			return { path, state: "complete", findings: [] };
		});
		expect(
			await engine.hook(
				{ session_id: "s1", turn_id: "t1", hook_event_name: "PostToolUse", cwd: root },
				new AbortController().signal,
			),
		).toBe("");
		expect(checks).toBe(0);
		await engine.close();
	});

	it("checks only files that changed after the baseline", async () => {
		const root = await fixture();
		const checked: string[] = [];
		const engine = new Engine(root, async (path) => {
			checked.push(path);
			return {
				path,
				state: "complete",
				findings: [{ path, line: 1, column: 1, severity: "error", source: "fake", message: "broken" }],
			};
		});
		await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "SessionStart", cwd: root },
			new AbortController().signal,
		);
		await writeFile(join(root, "broken.ts"), "broken\n");
		const output = await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "PostToolUse", tool_name: "apply_patch", cwd: root },
			new AbortController().signal,
		);
		expect(checked).toEqual(["broken.ts"]);
		expect(output).toContain("broken.ts");
		expect(output).toContain("additionalContext");
		expect(output).not.toContain('"decision"');
		const second = await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "PostToolUse", tool_name: "Bash", cwd: root },
			new AbortController().signal,
		);
		expect(second).toBe("");
		expect(checked).toEqual(["broken.ts"]);
		await engine.close();
	});

	it("clears deleted paths and stays silent when diagnostics are clean", async () => {
		const root = await fixture();
		const engine = new Engine(root, async (path) => ({ path, state: "complete", findings: [] }));
		await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "SessionStart", cwd: root },
			new AbortController().signal,
		);
		await writeFile(join(root, "new.ts"), "export {};\n");
		expect(
			await engine.hook(
				{ session_id: "s1", turn_id: "t1", hook_event_name: "PostToolUse", cwd: root },
				new AbortController().signal,
			),
		).toBe("");
		await rm(join(root, "new.ts"));
		expect(
			await engine.hook(
				{ session_id: "s1", turn_id: "t1", hook_event_name: "PostToolUse", cwd: root },
				new AbortController().signal,
			),
		).toBe("");
		expect(await engine.cached("all", "s1")).not.toContain("new.ts");
		await engine.close();
	});

	it("drops session state on SessionEnd", async () => {
		const root = await fixture();
		const engine = new Engine(root, async (path) => ({
			path,
			state: "complete",
			findings: [{ path, line: 1, column: 1, severity: "warning", source: "fake", message: "warn" }],
		}));
		await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "SessionStart", cwd: root },
			new AbortController().signal,
		);
		await writeFile(join(root, "warn.ts"), "warn\n");
		await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "PostToolUse", cwd: root },
			new AbortController().signal,
		);
		await engine.hook(
			{ session_id: "s1", turn_id: "t1", hook_event_name: "SessionEnd", cwd: root },
			new AbortController().signal,
		);
		expect(await engine.dispatch("check_diagnostics", { mode: "status" }, new AbortController().signal)).toContain(
			"sessions=none",
		);
		await engine.close();
	});
});
