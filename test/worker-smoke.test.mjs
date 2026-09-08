import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("dist/cli.js");
test("MCP and Hook share one warm LSP and explicit writes recheck diagnostics", { timeout: 30000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "codex-worker-"));
	const root = join(dir, "project");
	const home = join(dir, "home");
	const cache = join(dir, "cache");
	await mkdir(root); await mkdir(home);
	const log = join(dir, "spawns");
	const config = join(home, "lsp-client.json");
	await writeFile(config, JSON.stringify({ trustedWorkspaces: [root], lsp: { fake: { command: [process.execPath, resolve("test/fixtures/fake-lsp.mjs")], extensions: [".fake"], env: { CODEX_LSP_TEST_LOG: log } } } }));
	await writeFile(join(root, "main.fake"), "broken\n");
	const env = { ...process.env, CODEX_HOME: home, CODEX_LSP_CACHE: cache, LSP_TOOLS_MCP_USER_CONFIG: config };
	t.after(async () => {
		for (const entry of await readdir(cache).catch(() => [])) {
			try { const pid = Number(await readFile(join(cache, entry, "ready"), "utf8")); process.kill(pid, "SIGTERM"); } catch { /* Already stopped. */ }
		}
		await new Promise((r) => setTimeout(r, 300));
		await rm(dir, { recursive: true, force: true });
	});
	const call = (name, args = {}) => {
		const child = spawnSync(process.execPath, [cli, "mcp"], { cwd: root, env, encoding: "utf8", timeout: 12000, input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { workspace: root, session: "test", ...args } } })}\n` });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout).result;
		assert(!result.isError, JSON.stringify(result));
		return result.content[0].text;
	};
	const hook = (event) => {
		const child = spawnSync(process.execPath, [cli, "hook"], { cwd: root, env, encoding: "utf8", timeout: 12000, input: JSON.stringify({ cwd: root, session_id: "test", turn_id: "t1", hook_event_name: event, tool_name: "Bash", tool_response: { exit_code: 1 } }) });
		assert.equal(child.status, 0, child.stderr);
		return child.stdout;
	};
	assert.equal(hook("SessionStart"), "");
	assert.match(call("lsp_diagnostics", { path: "main.fake" }), /fake\/E1/);
	assert.match(call("lsp_diagnostics", { path: "main.fake" }), /fake\/E1/);
	assert.match(call("lsp_navigation", { path: "main.fake", operation: "definition" }), /main.fake/);
	await writeFile(join(root, "main.fake"), "broken again\n");
	assert.match(hook("PostToolUse"), /broken fixture/);
	assert.match(call("check_diagnostics", { mode: "all" }), /broken fixture/);
	assert.equal(hook("PostToolUse"), "");
	assert.match(call("lsp_format", { path: "main.fake" }), /Formatted/);
	assert.equal(await readFile(join(root, "main.fake"), "utf8"), "fixed! again\n");
	assert.doesNotMatch(call("check_diagnostics", { mode: "all" }), /broken fixture/);
	assert.match(call("lsp_navigation", { operation: "rename", path: "main.fake", newName: "renamed" }), /Renamed/);
	assert.equal(await readFile(join(root, "main.fake"), "utf8"), "renamed again\n");
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1, "all Hook/MCP requests must reuse one LSP");
});
