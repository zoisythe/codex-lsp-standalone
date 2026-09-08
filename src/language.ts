import { readFile, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LspClient } from "../packages/lsp-tools-mcp/dist/lsp/client.js";
import { withLspClient } from "../packages/lsp-tools-mcp/dist/lsp/client-wrapper.js";
import { getLanguageId } from "../packages/lsp-tools-mcp/dist/lsp/language-mappings.js";
import { LspManager } from "../packages/lsp-tools-mcp/dist/lsp/manager.js";
import type { Diagnostic, TextEdit, WorkspaceEdit } from "../packages/lsp-tools-mcp/dist/lsp/types.js";
import { applyTextChanges, inside, inventory, workspacePath } from "./files.js";
import { type FileResult, message, number, record, text } from "./results.js";

class Client extends LspClient {
	private published = new Map<string, { version?: number; items: Diagnostic[] }>();
	private versions = new Map<string, { version: number; content: string }>();
	override async start(): Promise<void> {
		await super.start();
		this.connection?.onNotification("textDocument/publishDiagnostics", (value) => {
			if (!record(value) || typeof value["uri"] !== "string" || !Array.isArray(value["diagnostics"])) return;
			const items = value["diagnostics"] as Diagnostic[];
			const version = value["version"];
			this.published.set(value["uri"], typeof version === "number" ? { version, items } : { items });
		});
	}
	override async openFile(path: string): Promise<void> {
		const uri = pathToFileURL(path).href;
		const content = await readFile(path, "utf8");
		const previous = this.versions.get(uri);
		if (previous?.content === content) return;
		this.published.delete(uri);
		const version = (previous?.version ?? 0) + 1;
		this.versions.set(uri, { content, version });
		if (previous) {
			await this.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
		} else {
			await this.sendNotification("textDocument/didOpen", {
				textDocument: { uri, version, languageId: getLanguageId(extname(path)), text: content },
			});
		}
	}
	async refresh(paths: string[]): Promise<void> {
		// Invalidating push results alone leaves unchanged open documents permanently pending
		// on servers that publish only after didOpen/didChange. Close them so the next request
		// synchronizes the final disk contents, including deleted/moved dependencies.
		for (const uri of this.versions.keys())
			await this.sendNotification("textDocument/didClose", { textDocument: { uri } });
		this.versions.clear();
		this.published.clear();
		await this.sendNotification("workspace/didChangeWatchedFiles", {
			changes: paths.map((path) => ({ uri: pathToFileURL(path).href, type: 2 })),
		});
	}
	async collect(path: string): Promise<{ items: Diagnostic[]; ready: boolean }> {
		const uri = pathToFileURL(path).href;
		await this.openFile(path);
		await this.sendNotification("textDocument/didSave", { textDocument: { uri } });
		try {
			const result = await this.sendRequest<{ items?: Diagnostic[] }>("textDocument/diagnostic", {
				textDocument: { uri },
			});
			if (Array.isArray(result.items)) return { items: result.items, ready: true };
		} catch (error) {
			if (
				!(record(error) && error["code"] === -32601) &&
				!/method not found|unsupported|not supported|unknown request|unhandled method/i.test(message(error))
			)
				throw error;
		}
		for (let i = 0; i < 40; i++) {
			const result = this.published.get(uri);
			if (result && (result.version === undefined || result.version === this.versions.get(uri)?.version))
				return { items: result.items, ready: true };
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return { items: [], ready: false };
	}
	async formatting(path: string): Promise<TextEdit[]> {
		await this.openFile(path);
		return (
			(await this.sendRequest<TextEdit[] | null>("textDocument/formatting", {
				textDocument: { uri: pathToFileURL(path).href },
				options: { tabSize: 4, insertSpaces: true },
			})) ?? []
		);
	}
}

export class Languages {
	private manager: LspManager;
	private readonly clients = new Set<Client>();
	private snapshot = new Map<string, string>();
	async sync(files: Map<string, string>): Promise<void> {
		const changed = [...new Set([...files.keys(), ...this.snapshot.keys()])].filter(
			(path) => files.get(path) !== this.snapshot.get(path),
		);
		this.snapshot = new Map(files);
		for (const client of this.clients) {
			if (!client.isAlive()) {
				this.clients.delete(client);
				continue;
			}
			await client.refresh(changed.map((path) => resolve(this.root, path)));
		}
	}
	constructor(private readonly root: string) {
		this.manager = new LspManager({
			clientFactory: (root, server) => {
				if (!inside(this.root, root))
					throw new Error("LSP root outside workspace; choose the enclosing project as workspace");
				const client = new Client(root, server);
				this.clients.add(client);
				return client;
			},
		});
	}
	async check(path: string, signal: AbortSignal): Promise<FileResult> {
		try {
			return await withLspClient(
				await workspacePath(this.root, path),
				async (client) => {
					if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
					const result = await client.collect(await workspacePath(this.root, path));
					return {
						path,
						state: result.ready ? "complete" : "pending",
						findings: result.items
							.filter((item) => item.severity === 1 || item.severity === 2)
							.map((item) => ({
								path,
								line: item.range.start.line + 1,
								column: item.range.start.character + 1,
								severity: item.severity === 1 ? ("error" as const) : ("warning" as const),
								source: `${item.source ?? "lsp"}${item.code === undefined ? "" : `/${item.code}`}`,
								message: item.message,
							})),
						...(!result.ready ? { note: "No fresh diagnostics published yet" } : {}),
					};
				},
				"diagnostics",
				{ manager: this.manager, signal },
			);
		} catch (error) {
			const note = message(error);
			return { path, state: /No LSP server|NOT INSTALLED/.test(note) ? "skipped" : "failed", findings: [], note };
		}
	}
	async navigate(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		const path = await workspacePath(this.root, text(args["path"]));
		const operation = text(args["operation"]);
		const line = number(args["line"], 1, 1, 10000000);
		const column = number(args["column"], 1, 1, 1000000) - 1;
		const before = operation === "rename" ? await inventory(this.root) : undefined;
		return withLspClient(
			path,
			async (client) => {
				let result: unknown;
				switch (operation) {
					case "definition":
						result = await client.definition(path, line, column);
						break;
					case "references":
						result = await client.references(path, line, column);
						break;
					case "symbols":
						result = args["query"]
							? await client.workspaceSymbols(text(args["query"]))
							: await client.documentSymbols(path);
						break;
					case "prepare_rename":
						result = await client.prepareRename(path, line, column);
						break;
					case "rename": {
						if (!before?.complete) throw new Error("Cannot safely snapshot workspace for rename");
						const name = text(args["newName"]);
						if (!name) throw new Error("newName required");
						const edit = await client.rename(path, line, column, name);
						return this.applyRename(edit, before.version, signal);
					}
					default:
						throw new Error("Unknown navigation operation");
				}
				const output = JSON.stringify(result ?? []);
				return output.length <= 8000 ? output : `${output.slice(0, 7800)}\n(truncated; narrow query/path)`;
			},
			operation,
			{ manager: this.manager, signal },
		);
	}
	private async applyRename(edit: WorkspaceEdit | null, version: string, signal: AbortSignal): Promise<string> {
		if (!edit) return "No rename edits";
		const changes = new Map<string, TextEdit[]>();
		for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.set(uri, edits);
		for (const change of edit.documentChanges ?? []) {
			if ("kind" in change) throw new Error("Resource operations are not permitted by rename");
			if (changes.has(change.textDocument.uri)) throw new Error("Duplicate rename target");
			changes.set(change.textDocument.uri, change.edits);
		}
		const pending = [];
		for (const [uri, edits] of changes) {
			const path = await workspacePath(this.root, fileURLToPath(uri));
			const before = await readFile(path, "utf8");
			pending.push({ path, before, after: applyTextChanges(before, edits) });
		}
		if ((await inventory(this.root)).version !== version) throw new Error("Workspace changed during rename; retry");
		for (const item of pending)
			if ((await readFile(item.path, "utf8")) !== item.before) throw new Error("Rename conflict");
		signal.throwIfAborted();
		for (const item of pending) await writeFile(item.path, item.after);
		return `Renamed: ${pending.map((item) => relative(this.root, item.path)).join(", ")}`;
	}
	async format(path: string, signal: AbortSignal): Promise<string> {
		const absolute = await workspacePath(this.root, path);
		const before = await readFile(absolute, "utf8");
		const edits = await withLspClient(
			absolute,
			async (client) => {
				if (!(client instanceof Client)) throw new Error("Unexpected LSP client");
				return client.formatting(absolute);
			},
			"format",
			{ manager: this.manager, signal },
		);
		const after = applyTextChanges(before, edits);
		if ((await readFile(absolute, "utf8")) !== before) throw new Error("File changed during formatting; retry");
		if (after === before) return `Unchanged: ${path}`;
		signal.throwIfAborted();
		await writeFile(absolute, after);
		return `Formatted: ${path}`;
	}
	async close(): Promise<void> {
		await this.manager.stopAll();
	}
}
