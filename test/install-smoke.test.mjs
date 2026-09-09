import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const repo = resolve(import.meta.dirname, "..");

test("bundle initializes without development dependencies", async (t) => {
	const temp = await mkdtemp(join(tmpdir(), "codex-lsp-bundle-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	await cp(join(repo, "dist"), join(temp, "dist"), { recursive: true });
	await writeFile(join(temp, "package.json"), '{"type":"module"}');
	const child = spawnSync(process.execPath, [join(temp, "dist/cli.js"), "mcp"], {
		cwd: temp,
		input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
		encoding: "utf8",
		timeout: 3000,
	});
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout).id, 1);
});

test(
	"non-recursive plugin delivery: isolated initialize, tools, missing server, ping and EOF",
	{ timeout: 20000 },
	async (t) => {
		const temp = await mkdtemp(join(tmpdir(), "codex-lsp-install-"));
		t.after(() => rm(temp, { recursive: true, force: true }));
		const root = join(temp, "插件 root with spaces");
		const workspace = join(temp, "用户 workspace");
		await mkdir(root);
		await mkdir(workspace);
		for (const file of ["dist", "package.json", ".mcp.json", ".codex-plugin", "hooks", "skills", "LICENSE", "NOTICE"]) {
			await cp(join(repo, file), join(root, file), { recursive: true });
		}
		const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
		assert.equal(config.$schema, undefined);
		const server = config.mcpServers.lsp;
		assert.deepEqual(server.args, ["./dist/cli.js", "mcp"]);
		assert.equal(server.cwd, ".");
		const plugin = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"));
		const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		assert.equal(plugin.skills, "./skills/");
		assert(pkg.files.includes("skills"));
		assert.equal(pkg.dependencies, undefined);
		assert.equal(pkg.optionalDependencies, undefined);
		assert((await readFile(join(root, "skills/lsp/SKILL.md"), "utf8")).startsWith("---\n"));

		const missing = join(workspace, "missing-config.json");
		await writeFile(
			missing,
			JSON.stringify({
				lsp: {
					missing: { command: ["codex-lsp-deliberately-absent"], extensions: [".phaseone"] },
				},
			}),
		);
		await writeFile(join(workspace, "example.phaseone"), "broken\n");
		// Advance only long timers: detects the old ten-minute idle timeout without a ten-minute CI wait.
		const clock = join(temp, "accelerated-clock.mjs");
		await writeFile(
			clock,
			"const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms >= 600000 ? 25 : ms, ...args);\n",
		);
		for (const cwd of [workspace, root]) {
			const child = spawn(
				process.execPath,
				["--import", pathToFileURL(clock).href, join(root, server.args[0]), ...server.args.slice(1)],
				{
					cwd,
					env: {
						...process.env,
						PATH: "",
						NODE_PATH: "",
						NODE_OPTIONS: "",
						CODEX_LSP_CACHE: join(temp, "cache"),
						LSP_TOOLS_MCP_PROJECT_CONFIG: missing,
						LSP_TOOLS_MCP_USER_CONFIG: join(temp, "no-user-config"),
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			t.after(() => {
				if (child.exitCode === null) child.kill();
			});
			const exit = once(child, "exit");
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", (text) => {
				stderr += text;
			});
			const lines = createInterface({ input: child.stdout });
			const responses = [];
			lines.on("line", (line) => responses.push(JSON.parse(line)));
			const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
			const response = async (id) => {
				for (let i = 0; i < 800; i++) {
					const found = responses.find((value) => value.id === id);
					if (found) return found;
					assert.equal(child.exitCode, null, stderr);
					await delay(5);
				}
				assert.fail(`Timed out waiting for ${id}: ${stderr}`);
			};
			const start = performance.now();
			send({
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "clean-install", version: "1" },
				},
			});
			assert.equal((await response(1)).result.protocolVersion, "2024-11-05");
			assert(performance.now() - start < 2000, "initialize must not start or await LSP");
			send({ method: "notifications/initialized" });
			send({ id: 2, method: "tools/list" });
			const tools = (await response(2)).result.tools.map((tool) => tool.name);
			assert.deepEqual(tools, ["check_diagnostics", "lsp_diagnostics", "lsp_navigation", "lsp_format"]);
			await delay(100);
			send({ id: 3, method: "ping" });
			assert.deepEqual((await response(3)).result, {});
			send({ method: "notifications/cancelled", params: { requestId: "unknown" } });
			send({
				id: 4,
				method: "tools/call",
				params: {
					name: "lsp_diagnostics",
					arguments: { workspace, path: "example.phaseone" },
				},
			});
			assert.match(JSON.stringify(await response(4)), /NOT INSTALLED|No LSP server|skipped/i);
			send({ id: 5, method: "ping" });
			await response(5);
			assert.deepEqual(
				responses.map((value) => value.id),
				[1, 2, 3, 4, 5],
				"notifications have no responses; stdout is protocol only",
			);
			child.stdin.end();
			assert.deepEqual(await exit, [0, null]);
			assert.equal(stderr, "");
		}
	},
);
