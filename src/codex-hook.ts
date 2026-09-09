import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { stdin } from "node:process";
import { promisify } from "node:util";
import { HookEngine } from "./hook-engine.js";
import { message, record, text } from "./results.js";

export async function runHookCli(): Promise<void> {
	stdin.setEncoding("utf8");
	let raw = "";
	for await (const chunk of stdin) {
		raw += chunk;
		if (raw.length > 1024 * 1024) throw new Error("Hook input too large");
	}
	if (!raw.trim()) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid Hook JSON");
	}
	if (!record(parsed)) throw new Error("Hook input must be an object");
	const event = text(parsed["hook_event_name"], "PostToolUse");
	const budget = event === "SessionEnd" ? 1600 : event === "Stop" || event === "SubagentStop" ? 44000 : 4400;
	const signal = AbortSignal.timeout(budget);
	let root = await realpath(text(parsed["cwd"], process.cwd()));
	try {
		const result = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], {
			cwd: root,
			timeout: 1000,
			signal,
		});
		root = await realpath(result.stdout.trim());
	} catch {
		/* Non-Git workspace retains the explicit session cwd. */
	}
	try {
		const output = await new HookEngine(root).hook(parsed, signal);
		if (output) process.stdout.write(`${output}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ systemMessage: signal.aborted ? "Codex LSP: Hook budget reached; unfinished checks remain pending. Discovery will retry from the last committed baseline. LSP not executed." : `Codex LSP unavailable: ${message(error).slice(0, 300)}` })}\n`,
		);
	}
}
