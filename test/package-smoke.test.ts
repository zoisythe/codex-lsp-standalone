import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageJson = {
	readonly version: string;
	readonly type: string;
	readonly packageManager: string;
	readonly bin: Record<string, string>;
	readonly files: readonly string[];
	readonly dependencies?: Record<string, string>;
	readonly optionalDependencies?: Record<string, string>;
};

type PluginJson = {
	readonly version: string;
	readonly hooks: string;
	readonly mcpServers: string;
	readonly skills?: unknown;
};

type HookCommand = {
	readonly command: string;
};

type HookEntry = {
	readonly hooks: readonly HookCommand[];
};

type HooksJson = {
	readonly hooks: Record<string, readonly HookEntry[]>;
};

type McpServer = {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
};

type McpJson = {
	readonly mcpServers: Record<string, McpServer>;
};

function readPackageJson(path: string): PackageJson {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isPackageJson(parsed)) throw new TypeError(`Invalid package metadata: ${path}`);
	return parsed;
}

function readPluginJson(path: string): PluginJson {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isPluginJson(parsed)) throw new TypeError(`Invalid plugin metadata: ${path}`);
	return parsed;
}

function readHooksJson(path: string): HooksJson {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isHooksJson(parsed)) throw new TypeError(`Invalid hooks metadata: ${path}`);
	return parsed;
}

function readMcpJson(path: string): McpJson {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isMcpJson(parsed)) throw new TypeError(`Invalid MCP metadata: ${path}`);
	return parsed;
}

describe("plugin package metadata", () => {
	it("ships a self-contained bundle entry without skills or runtime package deps", () => {
		const packageJson = readPackageJson("package.json");
		const pluginJson = readPluginJson(".codex-plugin/plugin.json");
		const hooksJson = readHooksJson("hooks/hooks.json");
		const mcpJson = readMcpJson(".mcp.json");
		const cliSource = readFileSync("src/cli.ts", "utf8");
		const pluginRoot = ["$", "{PLUGIN_ROOT}"].join("");
		const lspServer = mcpJson.mcpServers["lsp"];
		const postToolUse = hooksJson.hooks["PostToolUse"]?.[0]?.hooks[0]?.command;
		const sessionStart = hooksJson.hooks["SessionStart"]?.[0]?.hooks[0]?.command;

		expect(pluginJson.version).toBe(packageJson.version);
		expect(packageJson.version).toBe("0.3.0");
		expect(packageJson.type).toBe("module");
		expect(packageJson.packageManager).toBe("npm@11.12.1");
		expect(packageJson.dependencies).toBeUndefined();
		expect(packageJson.optionalDependencies).toBeUndefined();
		expect(packageJson.files).toEqual([
			"dist",
			"hooks",
			".codex-plugin",
			".mcp.json",
			"LICENSE",
			"NOTICE",
			"README.md",
			"CHANGELOG.md",
		]);
		expect(packageJson.files).not.toContain("skills");
		expect(packageJson.bin["codex-lsp"]).toBe("./dist/cli.js");
		expect(pluginJson.hooks).toBe("./hooks/hooks.json");
		expect(pluginJson.mcpServers).toBe("./.mcp.json");
		expect(pluginJson.skills).toBeUndefined();
		expect(existsSync("skills/lsp/SKILL.md")).toBe(false);
		expect(cliSource.startsWith("#!/usr/bin/env node")).toBe(true);
		expect(sessionStart).toBe(`node "${pluginRoot}/dist/cli.js" hook`);
		expect(postToolUse).toBe(`node "${pluginRoot}/dist/cli.js" hook`);
		expect(lspServer?.command).toBe("node");
		expect(lspServer?.args).toEqual(["./dist/cli.js", "mcp"]);
		expect(lspServer?.cwd).toBe(".");
	});
});

function isPackageJson(value: unknown): value is PackageJson {
	return (
		isRecord(value) &&
		typeof value["version"] === "string" &&
		value["type"] === "module" &&
		value["packageManager"] === "npm@11.12.1" &&
		isStringRecord(value["bin"]) &&
		Array.isArray(value["files"]) &&
		value["files"].every((item) => typeof item === "string") &&
		(value["dependencies"] === undefined || isStringRecord(value["dependencies"])) &&
		(value["optionalDependencies"] === undefined || isStringRecord(value["optionalDependencies"]))
	);
}

function isPluginJson(value: unknown): value is PluginJson {
	return (
		isRecord(value) &&
		typeof value["version"] === "string" &&
		typeof value["hooks"] === "string" &&
		typeof value["mcpServers"] === "string"
	);
}

function isHooksJson(value: unknown): value is HooksJson {
	if (!isRecord(value) || !isRecord(value["hooks"])) return false;
	return Object.values(value["hooks"]).every(isHookEntries);
}

function isHookEntries(value: unknown): value is readonly HookEntry[] {
	return Array.isArray(value) && value.every(isHookEntry);
}

function isHookEntry(value: unknown): value is HookEntry {
	return isRecord(value) && Array.isArray(value["hooks"]) && value["hooks"].every(isHookCommand);
}

function isHookCommand(value: unknown): value is HookCommand {
	return isRecord(value) && typeof value["command"] === "string";
}

function isMcpJson(value: unknown): value is McpJson {
	if (!isRecord(value) || !isRecord(value["mcpServers"])) return false;
	return Object.values(value["mcpServers"]).every(isMcpServer);
}

function isMcpServer(value: unknown): value is McpServer {
	return (
		isRecord(value) &&
		typeof value["command"] === "string" &&
		Array.isArray(value["args"]) &&
		value["args"].every((item) => typeof item === "string") &&
		(value["cwd"] === undefined || typeof value["cwd"] === "string")
	);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
