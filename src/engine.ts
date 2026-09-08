import { readFile, stat, writeFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { hash, type Inventory, inventory, workspacePath } from "./files.js";
import { Languages } from "./language.js";
import { type FileResult, message, number, record, render, text } from "./results.js";
import { formatWithRunner, lint } from "./runners.js";

type Checker = (path: string, signal: AbortSignal, lspOnly: boolean) => Promise<FileResult>;
interface Cached {
	version: string;
	content: string;
	result: FileResult;
}
interface Session {
	turn: string;
	touched: Set<string>;
	current: Set<string>;
	shown: Map<string, string>;
	baseline: Map<string, string>;
	hasBaseline: boolean;
}
export class Engine {
	private readonly cache = new Map<string, Cached>();
	private readonly sessions = new Map<string, Session>();
	private language: Languages | undefined;
	private previousSnapshot: Inventory | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly checker: Checker;
	constructor(
		readonly root: string,
		checker?: Checker,
	) {
		this.checker =
			checker ??
			(async (path, signal, lspOnly) => {
				this.language ??= new Languages(root);
				const lsp = await this.language.check(path, signal);
				if (lspOnly) return lsp;
				const runner = await lint(root, path, signal);
				if (!runner) return lsp;
				return {
					path,
					state: lsp.state === "complete" ? runner.state : lsp.state,
					findings: [...lsp.findings, ...runner.findings],
					...(lsp.note || runner.note ? { note: [lsp.note, runner.note].filter(Boolean).join("; ") } : {}),
				};
			});
	}
	private session(id: string, turn?: string): Session {
		let session = this.sessions.get(id);
		if (!session) {
			session = {
				turn: turn ?? "",
				touched: new Set(),
				current: new Set(),
				shown: new Map(),
				baseline: new Map(),
				hasBaseline: false,
			};
			this.sessions.set(id, session);
		}
		if (turn && session.turn !== turn) {
			session.turn = turn;
			session.current.clear();
		}
		return session;
	}
	private id(value: unknown): string {
		if (typeof value === "string" && value) return value;
		if (this.sessions.size === 1) return this.sessions.keys().next().value ?? "manual";
		if (this.sessions.size > 1)
			throw new Error(
				"Multiple sessions: provide session from Hook feedback, or a new unique session for manual checks",
			);
		return "manual";
	}
	async check(
		paths: string[],
		id: string,
		turn: string,
		lspOnly = false,
		signal: AbortSignal = new AbortController().signal,
		offset = 0,
	): Promise<string> {
		const snapshot = await inventory(this.root);
		const previous = this.previousSnapshot;
		if (previous?.version !== snapshot.version && this.language) {
			const configChanged = [...new Set([...snapshot.files.keys(), ...(previous?.files.keys() ?? [])])].some(
				(path) =>
					/(?:config|lock|manifest|Cargo\.toml|package\.json|go\.mod|pyproject)/i.test(path) &&
					previous?.files.get(path) !== snapshot.files.get(path),
			);
			if (configChanged) {
				await this.language.close();
				this.language = undefined;
			} else await this.language.sync(snapshot.files);
		}
		this.previousSnapshot = snapshot;
		const session = this.session(id, turn);
		const results: FileResult[] = [];
		const deadline = Date.now() + 45000;
		for (const requested of [...new Set(paths)]) {
			signal.throwIfAborted();
			let path = requested;
			try {
				path = relative(this.root, await workspacePath(this.root, requested));
			} catch (error) {
				results.push({ path, state: "skipped", findings: [], note: message(error) });
				this.cache.delete(path);
				session.touched.delete(path);
				continue;
			}
			session.touched.add(path);
			session.current.add(path);
			if (Date.now() >= deadline || results.length >= 200) {
				this.cache.delete(path);
				this.cache.delete(`lsp:${path}`);
				results.push({ path, state: "pending", findings: [], note: "Scan time budget reached" });
				continue;
			}
			const key = `${lspOnly ? "lsp:" : ""}${path}`;
			const cached = this.cache.get(key);
			const content = hash(await readFile(await workspacePath(this.root, path), "utf8"));
			if (
				snapshot.complete &&
				cached?.version === snapshot.version &&
				cached.content === content &&
				cached.result.state === "complete"
			) {
				results.push(cached.result);
				continue;
			}
			const result = await this.checker(path, signal, lspOnly);
			if (hash(await readFile(await workspacePath(this.root, path), "utf8")) !== content) {
				result.state = "stale";
				result.note = "File changed during diagnostics; retry";
			}
			this.cache.set(key, { version: snapshot.version, content, result });
			results.push(result);
		}
		const after = await inventory(this.root);
		if (!after.complete || after.version !== snapshot.version) {
			for (const result of results) {
				result.state = "stale";
				result.note = "Workspace changed or snapshot incomplete; retry";
			}
		}
		if (paths.length > 200 || !snapshot.complete)
			results.push({
				path: ".",
				state: "pending",
				findings: [],
				note: "File/snapshot budget exceeded; narrow paths",
			});
		return render(results, 50, 8192, offset);
	}
	private async entries(mode: string, id: string): Promise<FileResult[]> {
		const snapshot = await inventory(this.root);
		const session = this.session(id);
		const files = mode === "delta" ? session.current : session.touched;
		const results: FileResult[] = [];
		for (const path of files) {
			const entry = this.cache.get(path) ?? this.cache.get(`lsp:${path}`);
			if (!entry) {
				results.push({ path, state: "pending", findings: [] });
				continue;
			}
			let content: string | undefined;
			try {
				content = hash(await readFile(await workspacePath(this.root, path), "utf8"));
			} catch {
				// Missing or inaccessible explicit paths cannot retain a fresh result.
			}
			results.push(
				entry.version === snapshot.version && entry.content === content && snapshot.complete
					? entry.result
					: { ...entry.result, state: "stale", note: "Workspace changed; run active diagnostics" },
			);
		}
		return results;
	}
	async cached(mode: string, id: string, offset = 0): Promise<string> {
		return render(await this.entries(mode, id), 50, 8192, offset);
	}
	async feedback(id: string): Promise<string> {
		const session = this.session(id);
		const changed: FileResult[] = [];
		for (const result of await this.entries("all", id)) {
			if (result.state === "complete" && result.findings.length === 0) {
				session.shown.delete(result.path);
				continue;
			}
			if (result.state === "skipped" && result.note?.startsWith("No LSP server configured")) continue;
			const fingerprint = hash(JSON.stringify(result));
			if (session.shown.get(result.path) === fingerprint) continue;
			changed.push(result);
			session.shown.set(result.path, fingerprint);
		}
		return changed.length
			? `session=${id}\n${render(changed, 10, 1800)}\nDetails: check_diagnostics mode=all workspace=${this.root}`
			: "";
	}
	async hook(input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const id = text(input["session_id"], "hook");
		const session = this.session(id, text(input["turn_id"]));
		const snapshot = await inventory(this.root);
		const event = text(input["hook_event_name"], "PostToolUse");
		if (event === "SessionStart" || event === "PreToolUse") {
			if (!session.hasBaseline) {
				session.baseline = snapshot.files;
				session.hasBaseline = true;
			}
			return "";
		}
		if (event === "SessionEnd") {
			this.sessions.delete(id);
			return "";
		}
		// Without a prior baseline, adopt the current tree as dirty-preexisting state instead of
		// treating every tracked file as a fresh mutation from this turn.
		if (!session.hasBaseline) {
			session.baseline = snapshot.files;
			session.hasBaseline = true;
			return "";
		}
		const changed = [...snapshot.files]
			.filter(([path, version]) => session.baseline.get(path) !== version)
			.map(([path]) => path);
		for (const path of session.baseline.keys())
			if (!snapshot.files.has(path)) {
				this.cache.delete(path);
				this.cache.delete(`lsp:${path}`);
				session.touched.delete(path);
				session.current.delete(path);
				session.shown.delete(path);
			}
		session.baseline = snapshot.files;
		const stopping = event === "Stop" || event === "SubagentStop";
		if (stopping && input["stop_hook_active"] === true) return "";
		const retry = stopping
			? (await this.entries("all", id))
					.filter((entry) => entry.state === "pending" || entry.state === "stale")
					.map((entry) => entry.path)
			: [];
		const paths = [...new Set([...changed, ...retry])];
		if (paths.length) await this.check(paths, id, session.turn, false, signal);
		const output = await this.feedback(id);
		if (!output) return "";
		if (stopping) {
			const errors = (await this.entries("all", id)).some(
				(entry) => entry.state === "complete" && entry.findings.some((finding) => finding.severity === "error"),
			);
			return JSON.stringify(errors ? { decision: "block", reason: output } : { systemMessage: output });
		}
		return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: output } });
	}
	dispatch(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const task = this.queue.then(() => {
			signal.throwIfAborted();
			return this.execute(operation, args, signal);
		});
		this.queue = task.catch(() => undefined);
		return task;
	}
	private async paths(args: Record<string, unknown>, snapshot: Inventory): Promise<string[]> {
		const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
		if (values.length > 200 || !values.every((value) => typeof value === "string"))
			throw new Error("paths must contain at most 200 strings");
		const paths = new Set<string>();
		for (const value of values) {
			if (typeof value !== "string") continue;
			const absolute = await workspacePath(this.root, value);
			const prefix = relative(this.root, absolute);
			if ((await stat(absolute)).isFile()) paths.add(prefix);
			else
				for (const path of snapshot.files.keys())
					if (!prefix || path.startsWith(`${prefix}${sep}`)) paths.add(path);
		}
		return [...paths];
	}
	private async execute(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		if (operation === "hook") return this.hook(args, signal);
		const mode = text(args["mode"], "delta");
		if (operation === "check_diagnostics" && mode === "status")
			return `workspace=${this.root}\nsessions=${[...this.sessions.keys()].join(",") || "none"}\ncache=${this.cache.size}`;
		const id = this.id(args["session"]);
		if (operation === "check_diagnostics" && (mode === "all" || mode === "delta"))
			return this.cached(mode, id, number(args["offset"], 0));
		if (operation === "lsp_navigation") {
			this.language ??= new Languages(this.root);
			const before = args["operation"] === "rename" ? await inventory(this.root) : undefined;
			const output = await this.language.navigate(args, signal);
			if (before) {
				this.cache.clear();
				const after = await inventory(this.root);
				const changed = [...after.files]
					.filter(([path, version]) => before.files.get(path) !== version)
					.map(([path]) => path);
				await this.check([...new Set([text(args["path"]), ...changed])], id, "manual", false, signal);
			}
			return output;
		}
		const snapshot = await inventory(this.root);
		const paths = await this.paths(args, snapshot);
		if (operation === "lsp_format") {
			if (!args["paths"] && !args["path"]) throw new Error("Explicit formatting paths required");
			if (paths.length > 200) throw new Error("Format at most 200 explicitly scoped files");
			this.language ??= new Languages(this.root);
			const lines = [];
			for (const path of paths)
				lines.push((await formatWithRunner(this.root, path, signal)) ?? (await this.language.format(path, signal)));
			await this.check(paths, id, "manual", false, signal);
			return lines.join("\n").slice(0, 8000) || "No files";
		}
		if (operation !== "lsp_diagnostics" && !(operation === "check_diagnostics" && mode === "full"))
			throw new Error("Unknown tool or mode");
		const start = number(args["start"], 0);
		const selected = paths.slice(start, start + 200);
		const output = await this.check(
			selected,
			id,
			"manual",
			operation === "lsp_diagnostics",
			signal,
			number(args["offset"], 0),
		);
		return `${output}${start + 200 < paths.length ? `\npartial; next start=${start + 200}; remaining files=${paths.length - start - 200}` : ""}${!snapshot.complete ? "\npartial; inventory exceeded budget" : ""}`;
	}
	async close(): Promise<void> {
		await this.language?.close();
	}
	async save(path: string): Promise<void> {
		await writeFile(
			path,
			JSON.stringify({
				sessions: [...this.sessions].map(([id, session]) => [
					id,
					{
						turn: session.turn,
						hasBaseline: session.hasBaseline,
						touched: [...session.touched],
						baseline: [...session.baseline],
					},
				]),
			}),
			{ mode: 0o600 },
		);
	}
	async restore(path: string): Promise<void> {
		try {
			const data: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!record(data) || !Array.isArray(data["sessions"])) return;
			// Restore delivery boundaries only; never trust a previous process's diagnostics as fresh.
			for (const row of data["sessions"])
				if (Array.isArray(row) && typeof row[0] === "string" && record(row[1])) {
					const session = this.session(row[0], text(row[1]["turn"]));
					session.hasBaseline = row[1]["hasBaseline"] === true;
					const baseline = row[1]["baseline"];
					if (Array.isArray(baseline))
						for (const pair of baseline)
							if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string")
								session.baseline.set(pair[0], pair[1]);
					const touched = row[1]["touched"];
					if (Array.isArray(touched))
						for (const value of touched) if (typeof value === "string") session.touched.add(value);
				}
		} catch {
			/* Missing/corrupt state is a cold cache, never a clean scan. */
		}
	}
}
