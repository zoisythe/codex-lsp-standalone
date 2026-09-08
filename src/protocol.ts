import { createInterface } from "node:readline";
import { message, record, text } from "./results.js";
import { request } from "./worker.js";

const string = { type: "string" };
const scope = {
	workspace: { type: "string", description: "Absolute user repository path, never the plugin directory." },
	session: {
		type: "string",
		description: "Codex session id for cached/delta results; required when multiple sessions share this workspace.",
	},
	path: string,
	paths: { type: "array", items: string, maxItems: 200 },
};
const paging = {
	offset: { type: "integer", minimum: 0, maximum: 10000 },
	start: { type: "integer", minimum: 0, maximum: 10000 },
};
function tool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[],
	readOnly: boolean,
) {
	return {
		name,
		description,
		inputSchema: { type: "object", properties, required: ["workspace", ...required], additionalProperties: false },
		annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
	};
}
export const TOOLS = [
	tool(
		"check_diagnostics",
		"LSP/lint state: delta=current turn, all=session touched cache, full=active bounded repository scan, status=runtime. Stale/partial is not clean. Use start/offset continuation when returned.",
		{ ...scope, ...paging, mode: { type: "string", enum: ["delta", "all", "full", "status"] } },
		[],
		true,
	),
	tool(
		"lsp_diagnostics",
		"Actively check files/directories with LSP only. Defaults to workspace. Bounded multi-language scan; continue using returned start/offset.",
		{ ...scope, ...paging },
		[],
		true,
	),
	tool(
		"lsp_navigation",
		"LSP definition/references/symbols/prepare_rename/rename. Positions are 1-based. Rename writes workspace files sequentially; prepare first.",
		{
			...scope,
			operation: { type: "string", enum: ["definition", "references", "symbols", "prepare_rename", "rename"] },
			line: { type: "integer", minimum: 1 },
			column: { type: "integer", minimum: 1 },
			query: string,
			newName: string,
		},
		["path", "operation"],
		false,
	),
	tool(
		"lsp_format",
		"Explicitly format scoped files with the configured project formatter or LSP. Writes files, checks conflicts, then rechecks diagnostics. Never runs lint fix.",
		scope,
		[],
		false,
	),
];
function validateArguments(name: string, args: Record<string, unknown>): void {
	const definition = TOOLS.find((entry) => entry.name === name);
	if (!definition) throw new Error("Unknown tool");
	for (const key of definition.inputSchema.required) if (args[key] === undefined) throw new Error(`${key} required`);
	for (const [key, value] of Object.entries(args)) {
		const schema = definition.inputSchema.properties[key];
		if (!record(schema)) throw new Error(`Unknown argument: ${key}`);
		if (schema["type"] === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
		if (schema["type"] === "integer") {
			if (
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				(typeof schema["minimum"] === "number" && value < schema["minimum"]) ||
				(typeof schema["maximum"] === "number" && value > schema["maximum"])
			)
				throw new Error(`Invalid integer: ${key}`);
		}
		if (
			schema["type"] === "array" &&
			(!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string"))
		)
			throw new Error(`${key} must contain at most 200 strings`);
		if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) throw new Error(`Invalid ${key}`);
	}
}
export async function runMcp(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
	const controllers = new Map<string | number, AbortController>();
	const pending = new Set<Promise<void>>();
	const send = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
	const handle = async (value: unknown): Promise<void> => {
		if (!record(value)) {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			return;
		}
		const id = value["id"];
		const method = value["method"];
		const params = record(value["params"]) ? value["params"] : {};
		if (method === "notifications/cancelled") {
			const target = params["requestId"];
			if (typeof target === "string" || typeof target === "number") controllers.get(target)?.abort();
			return;
		}
		if (id === undefined) return;
		if (typeof id !== "string" && typeof id !== "number") {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid id" } });
			return;
		}
		const ok = (result: unknown) => send({ jsonrpc: "2.0", id, result });
		if (method === "initialize") {
			ok({
				protocolVersion: text(params["protocolVersion"], "2024-11-05"),
				serverInfo: { name: "codex-lsp", version: "0.3.0" }, // keep in sync with package.json
				capabilities: { tools: { listChanged: false } },
			});
			return;
		}
		if (method === "ping") {
			ok({});
			return;
		}
		if (method === "tools/list") {
			ok({ tools: TOOLS });
			return;
		}
		if (method === "resources/list") {
			ok({ resources: [] });
			return;
		}
		if (method === "resources/templates/list") {
			ok({ resourceTemplates: [] });
			return;
		}
		if (method !== "tools/call") {
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			return;
		}
		if (controllers.size >= 16 || controllers.has(id)) {
			send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Too many or duplicate requests" } });
			return;
		}
		const controller = new AbortController();
		controllers.set(id, controller);
		try {
			const name = text(params["name"]);
			if (!TOOLS.some((entry) => entry.name === name)) throw new Error("Unknown tool");
			if (!record(params["arguments"])) throw new Error("Tool arguments required");
			const args = params["arguments"];
			validateArguments(name, args);
			const result = await request(text(args["workspace"]), name, args, controller.signal);
			ok({ content: [{ type: "text", text: result }] });
		} catch (error) {
			ok({ isError: true, content: [{ type: "text", text: message(error).slice(0, 2000) }] });
		} finally {
			controllers.delete(id);
		}
	};
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		if (!line.trim()) continue;
		if (line.length > 1024 * 1024) {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
			continue;
		}
		const task = handle(value);
		pending.add(task);
		void task.finally(() => pending.delete(task));
	}
	await Promise.all(pending);
}
