import { readFile } from "node:fs/promises";
import { configuration } from "./config.js";
import { hash, inventory, workspacePath } from "./files.js";
import { analysisIdentity } from "./identity.js";
import { Metadata } from "./metadata.js";
import { type FileResult, render, text } from "./results.js";
import { lint } from "./runners.js";

type Linter = (path: string, signal: AbortSignal) => Promise<FileResult>;
export class HookEngine {
	private readonly store: Metadata;
	private readonly linter: Linter;
	constructor(
		private readonly root: string,
		linter?: Linter,
	) {
		this.store = new Metadata(root);
		this.linter =
			linter ??
			(async (path, signal) =>
				(await lint(root, path, signal)) ?? {
					path,
					state: "skipped",
					findings: [],
					note: "lint requires workspace trust",
				});
	}
	async hook(input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const id = text(input["session_id"]);
		if (!id)
			return JSON.stringify({ systemMessage: "Codex LSP: missing session_id; automatic checking unavailable" });
		const event = text(input["hook_event_name"], "PostToolUse");
		if (event === "SessionEnd") {
			await this.store.end(id, signal);
			return "";
		}
		const stopping = event === "Stop" || event === "SubagentStop";
		if (stopping && input["stop_hook_active"] === true) return "";
		const initial = await this.store.read(id);
		const config = await configuration(this.root);
		const snapshot = await inventory(this.root, 10000, signal, config.exclude);
		if (!snapshot.complete)
			return JSON.stringify({
				systemMessage:
					"Codex LSP: change discovery incomplete; baseline retained; narrow scope with check_diagnostics mode=full",
			});
		const changed = initial.baseline
			? [...snapshot.files].filter(([path, version]) => initial.baseline?.[path] !== version).map(([path]) => path)
			: [];
		const deleted = new Set<string>();
		for (const path of initial.touched) {
			signal.throwIfAborted();
			if (snapshot.files.has(path)) continue;
			try {
				await workspacePath(this.root, path);
			} catch {
				deleted.add(path);
			}
		}
		let registered = false;
		const state = await this.store.update(id, signal, (state) => {
			if (state.version !== initial.version) return false;
			if (state.turn === "__ended__" && event !== "SessionStart") return false;
			if (state.turn === "__ended__") state.turn = "";
			const turn = text(input["turn_id"]);
			if (turn && turn !== state.turn) {
				state.turn = turn;
				state.current = [];
			}
			if (!state.baseline || (event !== "SessionStart" && event !== "PreToolUse")) {
				state.baseline = Object.fromEntries(snapshot.files);
				state.touched = state.touched.filter((path) => !deleted.has(path));
				state.current = state.current.filter((path) => !deleted.has(path));
				state.pending = state.pending.filter((path) => snapshot.files.has(path));
				state.touched.push(...changed);
				state.current.push(...changed);
				state.pending.push(...changed);
			}
			registered = true;
			return true;
		});
		if (!registered || event === "SessionStart" || event === "PreToolUse") return "";
		const paths = [
			...new Set([...changed, ...state.pending.slice().sort(), ...(stopping ? state.touched.slice().sort() : [])]),
		];
		const completed: { result: FileResult; fingerprint: string; content: string; identity: string }[] = [];
		for (const path of paths.slice(0, 200)) {
			if (signal.aborted) break;
			const content = snapshot.files.get(path);
			if (!content) continue;
			const identity = await analysisIdentity(this.root, [path], config, signal, false);
			const result = await this.linter(path, signal);
			if (signal.aborted) break;
			try {
				if (hash(await readFile(await workspacePath(this.root, path), { encoding: "utf8", signal })) !== content)
					continue;
			} catch {
				continue;
			}
			completed.push({ result, content, identity, fingerprint: hash(JSON.stringify([content, identity, result])) });
		}
		// A separate bounded reserve permits committing completed work after the analysis deadline.
		const commitSignal = AbortSignal.timeout(350);
		if ((await configuration(this.root)).version !== config.version)
			return JSON.stringify({ systemMessage: "Codex LSP: configuration changed; pending retained" });
		for (let i = completed.length - 1; i >= 0; i--) {
			const entry = completed[i];
			if (!entry) continue;
			try {
				if (
					hash(
						await readFile(await workspacePath(this.root, entry.result.path), {
							encoding: "utf8",
							signal: commitSignal,
						}),
					) === entry.content &&
					(await analysisIdentity(this.root, [entry.result.path], config, commitSignal, false)) === entry.identity
				)
					continue;
			} catch {
				/* Deleted or changed. */
			}
			completed.splice(i, 1);
		}
		const changedResults: FileResult[] = [];
		let block = false;
		await this.store.update(id, commitSignal, (current) => {
			if (current.version !== state.version) return false;
			for (const { result, fingerprint } of completed) {
				if (result.state === "complete" || result.state === "skipped" || result.state === "failed")
					current.pending = current.pending.filter((path) => path !== result.path);
				const newFeedback = current.shown[result.path] !== fingerprint;
				if (newFeedback && (result.findings.length || result.state !== "complete")) changedResults.push(result);
				current.shown[result.path] = fingerprint;
				if (
					stopping &&
					result.state === "complete" &&
					result.findings.some((finding) => finding.severity === "error") &&
					!current.blocked.includes(fingerprint)
				) {
					block = true;
					current.blocked.push(fingerprint);
					if (!changedResults.includes(result)) changedResults.push(result);
				}
			}
			current.blocked = current.blocked.slice(-10000);
			return true;
		});
		if (!changedResults.length && !signal.aborted) return "";
		const output = `session=${id}\nLint channel: ${render(changedResults, 10, 1800)}${signal.aborted ? "\nLint budget reached; unfinished files remain pending." : ""}\nLSP not executed; use check_diagnostics mode=full workspace=${this.root}`;
		return JSON.stringify(
			stopping
				? block
					? { decision: "block", reason: output }
					: { systemMessage: output }
				: { hookSpecificOutput: { hookEventName: event, additionalContext: output } },
		);
	}
}
