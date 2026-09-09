import { spawn } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { terminateProcessTree } from "../packages/lsp-tools-mcp/dist/lsp/process.js";
import { configuration, trusted } from "./config.js";

export { trusted } from "./config.js";

import { inside, workspacePath } from "./files.js";
import { parseLint } from "./lint-output.js";
import { logEvent } from "./log.js";
import { type FileResult, message } from "./results.js";

export async function run(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal,
	input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const cancel = () => terminateProcessTree(child, "SIGKILL");
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		let stdout = "";
		let stderr = "";
		let exceeded = false;
		const timer = setTimeout(() => {
			exceeded = true;
			void logEvent("timeout");
			terminateProcessTree(child, "SIGKILL");
		}, 20000);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
				exceeded = true;
				terminateProcessTree(child, "SIGKILL");
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.once("error", (error) => {
			void logEvent("startup-failure");
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			if (code !== 0 && code !== 1 && !signal.aborted) void logEvent("abnormal-exit");
			if (signal.aborted) reject(new Error("Runner cancelled"));
			else if (exceeded) reject(new Error("Runner exceeded time/output budget"));
			else resolve({ stdout, stderr, code: code ?? -1 });
		});
		child.stdin.on("error", () => {
			/* Child may reject stdin before consuming it. */
		});
		child.stdin.end(input);
	});
}
interface Runner {
	name: "biome" | "eslint" | "ruff";
	command: string;
	prefix: string[];
}
async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
async function configured(root: string, path: string, names: string[]): Promise<boolean> {
	let dir = dirname(path);
	while (inside(root, dir)) {
		for (const name of names) if (await exists(join(dir, name))) return true;
		if (dir === root) break;
		dir = dirname(dir);
	}
	return false;
}
async function executable(root: string, packageName: string, entry: string): Promise<string> {
	let dir = root;
	while (true) {
		const path = join(dir, "node_modules", packageName, entry);
		if (await exists(path)) return realpath(path);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`${packageName}: configured tool is not installed`);
}
async function select(root: string, path: string, formatting = false): Promise<Runner | undefined> {
	const config = await configuration(root);
	const extension = extname(path);
	const choice = formatting ? "auto" : extension === ".py" ? config.python : config.javascript;
	if (choice === "off") return undefined;
	if (extension === ".py" && (await configured(root, path, ["pyproject.toml", "ruff.toml", ".ruff.toml"]))) {
		const local = join(root, ".venv", process.platform === "win32" ? "Scripts/ruff.exe" : "bin/ruff");
		return { name: "ruff", command: (await exists(local)) ? local : "ruff", prefix: [] };
	}
	if (extension === ".py" && choice === "ruff") throw new Error("ruff: matching project configuration missing");
	if (!/\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(path)) return undefined;
	if ((choice === "auto" || choice === "biome") && (await configured(root, path, ["biome.json", "biome.jsonc"])))
		return {
			name: "biome",
			command: process.execPath,
			prefix: [await executable(root, "@biomejs/biome", "bin/biome")],
		};
	if (
		(choice === "auto" || choice === "eslint") &&
		(await configured(root, path, [
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
			".eslintrc.json",
			".eslintrc.cjs",
		]))
	)
		return {
			name: "eslint",
			command: process.execPath,
			prefix: [await executable(root, "eslint", "bin/eslint.js")],
		};
	if (choice !== "auto") throw new Error(`${choice}: matching project configuration missing`);
	return undefined;
}
export async function runnerIdentity(root: string, path: string): Promise<string> {
	if (!(await trusted(root))) return "untrusted";
	try {
		return JSON.stringify(await select(root, path)) ?? "none";
	} catch {
		return "unavailable";
	}
}

export async function lint(root: string, path: string, signal: AbortSignal): Promise<FileResult | undefined> {
	if (!(await trusted(root))) return undefined;
	try {
		const absolute = await workspacePath(root, path);
		const runner = await select(root, absolute);
		if (!runner)
			return { path, state: "skipped", findings: [], note: "lint off or no matching Runner configuration" };
		const args =
			runner.name === "biome"
				? ["lint", "--reporter=json", "--max-diagnostics=1000", absolute]
				: runner.name === "eslint"
					? ["--format", "json", absolute]
					: ["check", "--no-cache", "--output-format", "json", "--", absolute];
		const result = await run(runner.command, [...runner.prefix, ...args], root, signal);
		if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `Runner exit ${result.code}`);
		const data: unknown = JSON.parse(result.stdout);
		const findings = parseLint(runner.name, data, path, await readFile(absolute, "utf8"));
		return { path, state: "complete", findings };
	} catch (error) {
		return { path, state: signal.aborted ? "pending" : "failed", findings: [], note: `lint: ${message(error)}` };
	}
}
export async function formatWithRunner(root: string, path: string, signal: AbortSignal): Promise<string | undefined> {
	if (!(await trusted(root))) return undefined;
	const absolute = await workspacePath(root, path);
	const runner = await select(root, absolute, true);
	if (!runner || runner.name === "eslint") return undefined;
	const before = await readFile(absolute, "utf8");
	const args =
		runner.name === "biome"
			? ["format", `--stdin-file-path=${absolute}`]
			: ["format", "--no-cache", "--stdin-filename", absolute, "-"];
	const result = await run(runner.command, [...runner.prefix, ...args], root, signal, before);
	if (result.code !== 0) throw new Error(result.stderr || "Format failed");
	if ((await readFile(absolute, "utf8")) !== before) throw new Error("File changed during format; retry");
	if (before === result.stdout) return `Unchanged: ${path}`;
	signal.throwIfAborted();
	await writeFile(absolute, result.stdout);
	return `Formatted: ${path}`;
}
