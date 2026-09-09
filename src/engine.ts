import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { configuration } from "./config.js";
import { hash, type Inventory, inventory, workspacePath } from "./files.js";
import { analysisIdentity } from "./identity.js";
import { Languages } from "./language.js";
import { logEvent } from "./log.js";
import { Metadata } from "./metadata.js";
import { type FileResult, message, number, render, text } from "./results.js";
import { formatWithRunner, lint } from "./runners.js";

type Checker = (path: string, signal: AbortSignal, lspOnly: boolean) => Promise<FileResult>;
interface Cached {
	identity: string;
	version: string;
	content: string;
	result: FileResult;
}
interface Session {
	turn: string;
	touched: Set<string>;
	current: Set<string>;
	shown: Map<string, string>;
}
export class Engine {
	private readonly identities = new Map<string, string>();
	private readonly cache = new Map<string, Cached>();
	private readonly sessions = new Map<string, Session>();
	private language: Languages | undefined;
	private configVersion = "";
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
				this.language ??= new Languages(root, await configuration(root));
				const lsp = await this.language.check(path, signal);
				if (lspOnly) return lsp;
				const runner = await lint(root, path, signal);
				if (!runner)
					return {
						...lsp,
						channels: { lsp: lsp.state, lint: "skipped" },
						note: [lsp.note, "lint requires workspace trust"].filter(Boolean).join("; "),
					};
				return {
					path,
					state: lsp.state === "complete" ? (runner.state === "skipped" ? "complete" : runner.state) : lsp.state,
					channels: { lsp: lsp.state, lint: runner.state },
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
	private async synchronize(snapshot: Inventory): Promise<void> {
		if (!snapshot.complete) await this.close();
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
	}

	async check(
		paths: string[],
		id: string,
		turn: string,
		lspOnly = false,
		signal: AbortSignal = new AbortController().signal,
		offset = 0,
	): Promise<string> {
		const config = await configuration(this.root);
		const snapshot = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
		snapshot.version = hash(snapshot.version + config.version);
		await this.synchronize(snapshot);
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
			const identity = await analysisIdentity(this.root, [path], config, signal);
			if (this.identities.has(path) && this.identities.get(path) !== identity) {
				await this.close();
				this.cache.clear();
			}
			this.identities.set(path, identity);
			const absolute = await workspacePath(this.root, path);
			if ((await stat(absolute)).size > 1024 * 1024) {
				results.push({ path, state: "skipped", findings: [], note: "File exceeds 1 MiB" });
				continue;
			}
			const content = hash(await readFile(absolute, { encoding: "utf8", signal }));
			if (
				snapshot.complete &&
				cached?.version === snapshot.version &&
				cached.identity === identity &&
				cached.content === content &&
				cached.result.state === "complete"
			) {
				results.push(cached.result);
				continue;
			}
			const result = await this.checker(path, signal, lspOnly);
			signal.throwIfAborted();
			if (
				hash(await readFile(await workspacePath(this.root, path), { encoding: "utf8", signal })) !== content ||
				(await analysisIdentity(this.root, [path], await configuration(this.root), signal)) !== identity
			) {
				result.state = "stale";
				result.note = "File changed during diagnostics; retry";
			}
			this.cache.set(key, { version: snapshot.version, identity, content, result });
			results.push(result);
		}
		const after = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
		after.version = hash(after.version + (await configuration(this.root)).version);
		if (after.version !== snapshot.version) {
			for (const result of results) {
				result.state = "stale";
				result.note = "Workspace changed or snapshot incomplete; retry";
			}
		}
		if (paths.length > 200)
			results.push({
				path: ".",
				state: "pending",
				findings: [],
				note: "File/snapshot budget exceeded; narrow paths",
			});
		return (
			render(results, 50, 8192, offset) +
			(!snapshot.complete ? "\nDependency inventory incomplete; workspace dependency freshness unverified" : "")
		);
	}
	private async entries(mode: string, id: string, signal = new AbortController().signal): Promise<FileResult[]> {
		const config = await configuration(this.root);
		const snapshot = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
		snapshot.version = hash(snapshot.version + config.version);
		const session = this.session(id);
		const files = mode === "delta" ? session.current : session.touched;
		const results: FileResult[] = [];
		for (const path of [...files].sort()) {
			signal.throwIfAborted();
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
				entry.version === snapshot.version &&
					entry.content === content &&
					snapshot.complete &&
					entry.identity === (await analysisIdentity(this.root, [path], config, signal))
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
	dispatch(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const writes = operation === "lsp_format" || (operation === "lsp_navigation" && args["operation"] === "rename");
		let started = false;
		const task = this.queue.then(() => {
			started = true;
			signal.throwIfAborted();
			return this.execute(operation, args, signal);
		});
		this.queue = task.catch(() => undefined);
		return new Promise((resolve, reject) => {
			const abort = () => {
				if (!started || !writes) reject(new Error("Request cancelled while queued or executing"));
				if (started) void this.close().catch(() => logEvent("cancel-cleanup-failure"));
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	}
	private async paths(
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ paths: string[]; complete: boolean }> {
		const config = await configuration(this.root);
		const values = Array.isArray(args["paths"]) ? args["paths"] : [text(args["path"], ".")];
		if (values.length > 200 || !values.every((value) => typeof value === "string"))
			throw new Error("paths must contain at most 200 strings");
		const paths = new Set<string>();
		let complete = true;
		for (const value of values) {
			if (typeof value !== "string") continue;
			signal.throwIfAborted();
			const absolute = await workspacePath(this.root, value);
			if ((await stat(absolute)).isFile()) paths.add(relative(this.root, absolute));
			else {
				const scoped = await inventory(this.root, 10000, signal, config.exclude, absolute);
				complete &&= scoped.complete;
				for (const path of scoped.files.keys()) {
					paths.add(path);
					if (paths.size > 10000) {
						complete = false;
						break;
					}
				}
			}
			if (paths.size > 10000) break;
		}
		return { paths: [...paths].sort().slice(0, 10000), complete };
	}
	private revision(args: Record<string, unknown>, version: string): void {
		if ((number(args["start"], 0) || number(args["offset"], 0)) && args["revision"] !== version)
			throw new Error("Invalid or missing revision; restart from start=0 offset=0");
	}
	private async fingerprints(paths: string[], signal: AbortSignal): Promise<string[]> {
		const contents: string[] = [];
		for (const path of paths) {
			signal.throwIfAborted();
			try {
				const absolute = await workspacePath(this.root, path);
				const info = await stat(absolute);
				contents.push(
					path,
					info.size > 1024 * 1024
						? `oversized:${info.size}:${info.mtimeMs}`
						: hash(await readFile(absolute, { encoding: "utf8", signal })),
				);
			} catch (error) {
				signal.throwIfAborted();
				contents.push(path, `unavailable:${message(error)}`);
			}
		}
		return contents;
	}

	private async execute(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		if (operation === "release") {
			await this.close();
			this.cache.clear();
			return "";
		}
		const config = await configuration(this.root);
		if (this.configVersion !== config.version || args["refresh"] === true) {
			await this.close();
			this.cache.clear();
			this.configVersion = config.version;
		}
		const store = new Metadata(this.root);
		const ids = await store.ids();
		for (const id of this.sessions.keys())
			if (!ids.includes(id) && (await store.read(id)).turn === "__ended__") this.sessions.delete(id);
		for (const id of ids) {
			const state = await store.read(id);
			if (state.turn === "__ended__") {
				this.sessions.delete(id);
				continue;
			}
			const session = this.session(id, state.turn);
			session.touched = new Set(state.touched);
			session.current = new Set(state.current);
		}
		const mode = text(args["mode"], "delta");
		if (operation === "check_diagnostics" && mode === "status")
			return `workspace=${this.root}\nsessions=${[...this.sessions.keys()].join(",") || "none"}\ncache=${this.cache.size}`;
		const id = this.id(args["session"]);
		if (operation === "check_diagnostics" && (mode === "all" || mode === "delta")) {
			let entries = await this.entries(mode, id, signal);
			if (args["path"] || args["paths"]) {
				const scope = await this.paths(args, signal);
				entries = entries.filter((entry) => scope.paths.includes(entry.path));
			}
			const revision = hash(
				JSON.stringify([
					operation,
					mode,
					args["path"],
					args["paths"],
					config.version,
					(await inventory(this.root, 10000, signal, config.exclude, this.root, true)).version,
					await this.fingerprints(
						entries.map((entry) => entry.path),
						signal,
					),
					entries,
				]),
			);
			this.revision(args, revision);
			return `${render(entries, 50, 8192, number(args["offset"], 0))}\nrevision=${revision}`;
		}
		if (operation === "lsp_navigation") {
			const path = relative(this.root, await workspacePath(this.root, text(args["path"])));
			const identity = await analysisIdentity(this.root, [path], config, signal);
			if (this.identities.has(path) && this.identities.get(path) !== identity) {
				await this.close();
				this.cache.clear();
			}
			this.identities.set(path, identity);
			const snapshot = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
			snapshot.version = hash(snapshot.version + config.version);
			await this.synchronize(snapshot);
			this.language ??= new Languages(this.root, await configuration(this.root));
			const before = args["operation"] === "rename" ? await inventory(this.root, 10000, signal) : undefined;
			let output: string;
			try {
				output = await this.language.navigate(args, signal);
			} finally {
				if (before) this.cache.clear();
			}
			if (before) {
				this.cache.clear();
				const after = await inventory(this.root, 10000, signal).catch((error: unknown) => {
					throw new Error(`${message(error)}; ${output}`);
				});
				const changed = [...after.files]
					.filter(([path, version]) => before.files.get(path) !== version)
					.map(([path]) => path);
				try {
					await this.check(
						[...new Set([text(args["path"]), ...changed])],
						id,
						this.session(id).turn,
						false,
						signal,
					);
				} catch (error) {
					throw new Error(`${message(error)}; ${output}`);
				}
			}
			return output;
		}
		const scope = await this.paths(args, signal);
		const paths = scope.paths;
		if (operation === "lsp_format") {
			if (!args["paths"] && !args["path"]) throw new Error("Explicit formatting paths required");
			if (paths.length > 200) throw new Error("Format at most 200 explicitly scoped files");
			this.language ??= new Languages(this.root, await configuration(this.root));
			const lines: string[] = [];
			try {
				for (const path of paths) {
					signal.throwIfAborted();
					lines.push(
						(await formatWithRunner(this.root, path, signal)) ?? (await this.language.format(path, signal)),
					);
				}
				await this.check(paths, id, "manual", false, signal);
			} catch (error) {
				throw new Error(`${message(error)}; completed writes: ${lines.join("; ") || "none"}`);
			} finally {
				this.cache.clear();
			}
			return lines.join("\n").slice(0, 8000) || "No files";
		}
		if (operation !== "lsp_diagnostics" && !(operation === "check_diagnostics" && mode === "full"))
			throw new Error("Unknown tool or mode");
		const snapshot = await inventory(this.root, 10000, signal, config.exclude, this.root, true);
		const contents = await this.fingerprints(paths, signal);
		const revision = hash(
			JSON.stringify([
				operation,
				mode,
				args["path"],
				args["paths"],
				contents,
				snapshot.version,
				await analysisIdentity(this.root, paths, config, signal),
			]),
		);
		this.revision(args, revision);
		const start = number(args["start"], 0);
		const selected = paths.slice(start, start + 200);
		await store.update(id, signal, (state) => {
			state.touched.push(...selected);
			state.current.push(...selected);
		});
		let output = await this.check(
			selected,
			id,
			this.session(id).turn,
			operation === "lsp_diagnostics",
			signal,
			number(args["offset"], 0),
		);
		if (start + 200 < paths.length || !scope.complete) output = output.replace(/^complete;/, "partial;");
		return `${output}${start + 200 < paths.length ? `\npartial; next start=${start + 200}; remaining files=${paths.length - start - 200}` : ""}${!scope.complete ? "\npartial; scope inventory exceeded budget" : ""}\nrevision=${revision}`;
	}
	async dispose(): Promise<void> {
		await this.close();
		await this.queue;
		await this.close();
	}
	async close(): Promise<void> {
		const language = this.language;
		this.language = undefined;
		await language?.close();
	}
}
