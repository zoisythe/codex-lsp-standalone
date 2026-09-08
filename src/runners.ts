import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { inside, workspacePath } from "./files.js";
import { parseLint } from "./lint-output.js";
import { type FileResult, message, record } from "./results.js";

export async function trusted(root: string): Promise<boolean> {
	if (process.env["CODEX_LSP_TRUST_PROJECT"] === "1") return true;
	try {
		const config: unknown = JSON.parse(
			await readFile(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "lsp-client.json"), "utf8"),
		);
		return record(config) && Array.isArray(config["trustedWorkspaces"]) && config["trustedWorkspaces"].includes(root);
	} catch {
		return false;
	}
}
export async function run(
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal,
	input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let exceeded = false;
		const timer = setTimeout(() => {
			exceeded = true;
			child.kill("SIGKILL");
		}, 20000);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
				exceeded = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (exceeded) reject(new Error("Runner exceeded time/output budget"));
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
async function select(root: string, path: string): Promise<Runner | undefined> {
	const extension = extname(path);
	if (extension === ".py" && (await configured(root, path, ["pyproject.toml", "ruff.toml", ".ruff.toml"]))) {
		const local = join(root, ".venv", process.platform === "win32" ? "Scripts/ruff.exe" : "bin/ruff");
		return { name: "ruff", command: (await exists(local)) ? local : "ruff", prefix: [] };
	}
	if (!/\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(path)) return undefined;
	const require = createRequire(join(root, "package.json"));
	if (await configured(root, path, ["biome.json", "biome.jsonc"]))
		return { name: "biome", command: process.execPath, prefix: [require.resolve("@biomejs/biome/bin/biome")] };
	if (
		await configured(root, path, [
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
			".eslintrc.json",
			".eslintrc.cjs",
		])
	)
		return {
			name: "eslint",
			command: process.execPath,
			prefix: [join(dirname(require.resolve("eslint/package.json")), "bin/eslint.js")],
		};
	return undefined;
}
export async function lint(root: string, path: string, signal: AbortSignal): Promise<FileResult | undefined> {
	if (!(await trusted(root))) return undefined;
	try {
		const absolute = await workspacePath(root, path);
		const runner = await select(root, absolute);
		if (!runner) return undefined;
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
		return { path, state: "failed", findings: [], note: `lint: ${message(error)}` };
	}
}
export async function formatWithRunner(root: string, path: string, signal: AbortSignal): Promise<string | undefined> {
	if (!(await trusted(root))) return undefined;
	const absolute = await workspacePath(root, path);
	const runner = await select(root, absolute);
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
