import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { findServerForExtension } from "../packages/lsp-tools-mcp/dist/lsp/server-resolution.js";
import { type Config, withConfiguration } from "./config.js";
import { hash, inside } from "./files.js";
import { runnerIdentity } from "./runners.js";

const CONFIGS = [
	"biome.json",
	"biome.jsonc",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	".eslintrc.json",
	".eslintrc.cjs",
	"pyproject.toml",
	"ruff.toml",
	".ruff.toml",
	"tsconfig.json",
	"jsconfig.json",
	"pyrightconfig.json",
	"package.json",
	"Cargo.toml",
	"go.mod",
];
// Direct workspace configuration is read even when scan exclusions hide it.
// External extends/imports and tool installation changes require refresh.
export async function analysisIdentity(
	root: string,
	paths: string[],
	config: Config,
	signal: AbortSignal,
	lsp = true,
): Promise<string> {
	const dirs = new Set<string>();
	const extensions = new Set<string>();
	const runners = new Map<string, string>();
	for (const path of paths) {
		signal.throwIfAborted();
		const absolute = resolve(root, path);
		extensions.add(extname(path));
		const key = `${dirname(absolute)}:${extname(path)}`;
		if (!runners.has(key)) runners.set(key, await runnerIdentity(root, absolute));
		let dir = dirname(absolute);
		while (inside(root, dir)) {
			dirs.add(dir);
			if (dir === root) break;
			dir = dirname(dir);
		}
	}
	const contents: string[] = [];
	for (const dir of [...dirs].sort())
		for (const name of CONFIGS) {
			signal.throwIfAborted();
			const path = join(dir, name);
			try {
				if ((await stat(path)).size > 1024 * 1024) throw new Error("Tool configuration exceeds 1 MiB");
				contents.push(path, hash(await readFile(path, { encoding: "utf8", signal })));
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
	const servers = lsp
		? withConfiguration(config, () => [...extensions].sort().map((extension) => findServerForExtension(extension)))
		: [];
	return hash(JSON.stringify([config.version, contents, [...runners].sort(), servers]));
}
