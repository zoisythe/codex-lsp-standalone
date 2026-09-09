import { appendFileSync } from "node:fs";
const log = process.env.CODEX_LSP_TEST_LOG;
if (log) appendFileSync(log, `${process.pid}\n`);
let buffer = Buffer.alloc(0);
const docs = new Map();
function send(value) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value }));
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}
function handle(value) {
	const { method, params = {}, id } = value;
	const mode = process.env.CODEX_LSP_TEST_MODE;
	if (mode === "slow" && ["textDocument/diagnostic", "shutdown", "textDocument/formatting"].includes(method)) return;
	if (mode === "slow-second" && method === "textDocument/formatting" && params.textDocument.uri.endsWith("b.fake")) return;
	if (method === "exit") { process.exit(0); }
	if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
		const doc = params.textDocument;
		const text = doc.text ?? params.contentChanges[0].text;
		docs.set(doc.uri, text);
		const uri = process.platform === "win32" ? doc.uri.replace(/^file:\/\/\/([A-Z]):/i, (_, drive) => `file:///${drive.toLowerCase()}%3A`) : doc.uri;
		send({ method: "textDocument/publishDiagnostics", params: { uri, version: doc.version, diagnostics: text.includes("broken") ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 1, source: "fake", code: "E1", message: "broken fixture" }] : [] } });
		return;
	}
	if (id === undefined) return;
	if (method === "initialize") { send({ id, result: { capabilities: { textDocumentSync: 1, documentFormattingProvider: true, renameProvider: { prepareProvider: true } } } }); return; }
	if (method === "textDocument/diagnostic") { send({ id, error: { code: -32601, message: "Unhandled method textDocument/diagnostic" } }); return; }
	const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
	if (method === "textDocument/formatting") { send({ id, result: [{ range, newText: "fixed!" }] }); return; }
	if (method === "textDocument/prepareRename") { send({ id, result: range }); return; }
	if (method === "textDocument/rename") {
		const changes = { [params.textDocument.uri]: [{ range, newText: params.newName }] };
		if (mode === "two-files") changes[new URL("b.fake", params.textDocument.uri).href] = [{ range, newText: params.newName }];
		send({ id, result: { changes } }); return;
	}
	if (method === "textDocument/definition") { send({ id, result: [{ uri: params.textDocument.uri, range }] }); return; }
	send({ id, result: null });
}
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString());
		if (!match) throw new Error("Invalid framing");
		const size = Number(match[1]);
		if (buffer.length < end + 4 + size) return;
		const body = buffer.subarray(end + 4, end + 4 + size).toString();
		buffer = buffer.subarray(end + 4 + size);
		handle(JSON.parse(body));
	}
});
