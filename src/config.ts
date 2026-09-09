import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { hash } from "./files.js";
import { record } from "./results.js";

export function configPaths(root: string): { user: string; project: string } {
	const user = process.env["LSP_TOOLS_MCP_USER_CONFIG"];
	const project = process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
	return {
		user: user
			? isAbsolute(user)
				? user
				: join(homedir(), user)
			: join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "lsp-client.json"),
		project: project
			? isAbsolute(project)
				? project
				: join(root, project)
			: join(root, ".codex", "lsp-client.json"),
	};
}
async function read(path: string): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return record(value) ? value : {};
	} catch (error) {
		if (record(error) && error["code"] === "ENOENT") return {};
		throw new Error("Cannot read valid lsp-client.json configuration");
	}
}
export async function trusted(root: string): Promise<boolean> {
	if (process.env["CODEX_LSP_TRUST_PROJECT"] === "1") return true;
	const user = await read(configPaths(root).user);
	return Array.isArray(user["trustedWorkspaces"]) && user["trustedWorkspaces"].includes(root);
}
export interface Config {
	javascript: "auto" | "biome" | "eslint" | "off";
	python: "auto" | "ruff" | "off";
	exclude: string[];
	version: string;
	user: string;
	project: string;
	trusted: boolean;
}
export async function configuration(root: string): Promise<Config> {
	const paths = configPaths(root);
	const user = await read(paths.user);
	const trust =
		process.env["CODEX_LSP_TRUST_PROJECT"] === "1" ||
		(Array.isArray(user["trustedWorkspaces"]) && user["trustedWorkspaces"].includes(root));
	const project = trust ? await read(paths.project) : {};
	const lint = { ...(record(user["lint"]) ? user["lint"] : {}), ...(record(project["lint"]) ? project["lint"] : {}) };
	const javascript = lint["javascript"] ?? "auto";
	const python = lint["python"] ?? "auto";
	if (javascript !== "auto" && javascript !== "biome" && javascript !== "eslint" && javascript !== "off")
		throw new Error("Invalid lint.javascript");
	if (python !== "auto" && python !== "ruff" && python !== "off") throw new Error("Invalid lint.python");
	const exclude = project["exclude"] ?? user["exclude"] ?? [];
	if (
		!Array.isArray(exclude) ||
		!exclude.every(
			(item): item is string =>
				typeof item === "string" &&
				!item.startsWith("!") &&
				!item.includes("\\") &&
				!isAbsolute(item) &&
				!item.split("/").includes(".."),
		)
	)
		throw new Error("exclude requires relative forward-slash globs without negation");
	return {
		javascript,
		python,
		exclude,
		trusted: trust,
		...paths,
		version: hash(JSON.stringify([user, project, trust, paths])),
	};
}
// The upstream resolver reads its configuration synchronously before its first await.
// Restore overrides immediately; never leave process-global workspace configuration across awaits.
export function withConfiguration<T>(config: Config, invoke: () => T): T {
	const user = process.env["LSP_TOOLS_MCP_USER_CONFIG"];
	const project = process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
	process.env["LSP_TOOLS_MCP_USER_CONFIG"] = config.user;
	process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = config.trusted
		? config.project
		: join(config.user, "disabled-project-config");
	try {
		return invoke();
	} finally {
		if (user === undefined) delete process.env["LSP_TOOLS_MCP_USER_CONFIG"];
		else process.env["LSP_TOOLS_MCP_USER_CONFIG"] = user;
		if (project === undefined) delete process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"];
		else process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = project;
	}
}
