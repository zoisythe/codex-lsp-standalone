import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { stdin } from "node:process";
import { promisify } from "node:util";
import { message, record, text } from "./results.js";
import { request } from "./worker.js";

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
	let root = await realpath(text(parsed["cwd"], process.cwd()));
	try {
		const result = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 3000 });
		root = await realpath(result.stdout.trim());
	} catch {
		/* Non-Git workspace retains the explicit session cwd. */
	}
	try {
		const output = await request(root, "hook", parsed, new AbortController().signal);
		if (output) process.stdout.write(`${output}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ systemMessage: `Codex LSP unavailable: ${message(error).slice(0, 300)}` })}\n`,
		);
	}
}
