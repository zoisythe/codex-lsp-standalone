#!/usr/bin/env node
import { runHookCli } from "./codex-hook.js";
import { restoreInstalledHome } from "./environment.js";
import { runMcp } from "./protocol.js";
import { message } from "./results.js";

async function main(): Promise<void> {
	restoreInstalledHome();
	const [command = "mcp"] = process.argv.slice(2);
	if (command === "mcp") await runMcp();
	else if (command === "hook") await runHookCli();
	else throw new Error("Usage: codex-lsp [mcp | hook]");
}
main().catch((error: unknown) => {
	process.stderr.write(`${message(error)}\n`);
	process.exitCode = 1;
});
