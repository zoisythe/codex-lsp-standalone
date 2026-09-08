#!/usr/bin/env node
// Development only: always rebuild the pinned source, never trust an existing dist.
// All build dependencies live at the standalone root; no submodule npm install is needed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = resolve(root, "packages/lsp-tools-mcp/tsconfig.build.json");
if (!existsSync(config)) {
	console.error("Development submodule missing. Run: git submodule update --init packages/lsp-tools-mcp");
	process.exit(1);
}
const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", config], {
	cwd: root,
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
