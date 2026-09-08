import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.js";
import { hash } from "./files.js";
import { message, record, text } from "./results.js";
import { trusted } from "./runners.js";

interface Address {
	dir: string;
	socket: string;
	token: string;
}
async function identity(root: string): Promise<{ dir: string; socket: string }> {
	const base =
		process.env["CODEX_LSP_CACHE"] ??
		join(tmpdir(), `codex-lsp-${process.getuid?.() ?? hash(homedir()).slice(0, 10)}`);
	await mkdir(base, { recursive: true, mode: 0o700 });
	const stat = await lstat(base);
	if (
		stat.isSymbolicLink() ||
		(process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
	)
		throw new Error("Unsafe worker cache permissions");
	let userConfig = "";
	try {
		userConfig = await readFile(
			join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "lsp-client.json"),
			"utf8",
		);
	} catch {
		/* optional */
	}
	const script = fileURLToPath(import.meta.url);
	const key = hash(
		JSON.stringify([
			root,
			hash(await readFile(script, "utf8")),
			process.execPath,
			process.env["PATH"],
			process.env["CODEX_HOME"],
			process.env["CODEX_LSP_TRUST_PROJECT"],
			process.env["LSP_TOOLS_MCP_USER_CONFIG"],
			process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"],
			userConfig,
		]),
	).slice(0, 24);
	const dir = join(base, key);
	await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
		if (!record(error) || error["code"] !== "EEXIST") throw error;
	});
	if ((await lstat(dir)).isSymbolicLink()) throw new Error("Unsafe cache directory");
	return { dir, socket: process.platform === "win32" ? `\\\\.\\pipe\\codex-lsp-${key}` : join(dir, "worker.sock") };
}
async function address(dir: string, socket: string): Promise<Address> {
	const token = await readFile(join(dir, "token"), "utf8");
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid worker token");
	return { dir, socket, token };
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function ensure(root: string): Promise<Address> {
	const { dir, socket } = await identity(root);
	const lock = join(dir, "lock");
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const pid = Number(await readFile(join(lock, "pid"), "utf8"));
			if (alive(pid) && (await readFile(join(dir, "ready"), "utf8")) === String(pid)) return address(dir, socket);
			if (!alive(pid)) {
				await rm(lock, { recursive: true, force: true });
				await rm(join(dir, "ready"), { force: true });
			}
		} catch {
			/* A concurrent launcher may still be writing the lock. */
		}
		try {
			await mkdir(lock, { mode: 0o700 });
			await writeFile(join(lock, "pid"), String(process.pid));
			const token = randomBytes(32).toString("hex");
			await writeFile(join(dir, "token"), token, { mode: 0o600 });
			await rm(join(dir, "ready"), { force: true });
			const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", root, dir, socket], {
				cwd: root,
				detached: true,
				windowsHide: true,
				stdio: "ignore",
				env: { ...process.env },
			});
			if (!child.pid) throw new Error("Worker failed to spawn");
			child.once("error", () => {
				/* Ready handshake reports launch failure. */
			});
			await writeFile(join(lock, "pid"), String(child.pid));
			child.unref();
		} catch (error) {
			if (!record(error) || error["code"] !== "EEXIST") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Worker did not become ready within 5 seconds; inspect cache lock/process");
}
export async function request(
	root: string,
	operation: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
): Promise<string> {
	if (!isAbsolute(root)) throw new Error("workspace must be an absolute project directory");
	root = await realpath(root);
	const target = await ensure(root);
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = createConnection(target.socket);
		let data = "";
		const cancel = () => socket.destroy(new Error("Request cancelled"));
		signal.addEventListener("abort", cancel, { once: true });
		socket.setTimeout(55000, () => socket.destroy(new Error("Worker request timed out; diagnostics may be pending")));
		socket.once("connect", () => socket.write(`${JSON.stringify({ token: target.token, operation, args })}\n`));
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1024 * 1024) socket.destroy(new Error("Worker response too large"));
			if (!data.includes("\n")) return;
			try {
				const value: unknown = JSON.parse(data);
				if (!record(value) || typeof value["output"] !== "string")
					throw new Error(
						record(value) ? text(value["error"], "Invalid worker response") : "Invalid worker response",
					);
				resolve(value["output"]);
			} catch (error) {
				reject(error);
			}
			socket.end();
		});
		socket.once("error", reject);
		socket.once("close", () => {
			signal.removeEventListener("abort", cancel);
			if (!data.includes("\n")) reject(new Error("Worker connection closed before response"));
		});
	});
}
export async function runWorker(root: string, dir: string, socketPath: string): Promise<void> {
	const token = await readFile(join(dir, "token"), "utf8");
	// Repository executable configuration requires user-level opt-in, never self-authorization.
	if (!(await trusted(root))) process.env["LSP_TOOLS_MCP_PROJECT_CONFIG"] = join(dir, "disabled-project-config");
	process.env["LSP_TOOLS_MCP_USER_CONFIG"] ??= join(
		process.env["CODEX_HOME"] ?? join(homedir(), ".codex"),
		"lsp-client.json",
	);
	const engine = new Engine(root);
	const statePath = join(dir, "state.json");
	await engine.restore(statePath);
	let active = 0;
	let lastUsed = Date.now();
	if (process.platform !== "win32") await rm(socketPath, { force: true });
	const server = createServer((socket) => {
		const controller = new AbortController();
		let buffer = "";
		let started = false;
		socket.setTimeout(60000, () => socket.destroy());
		socket.once("close", () => controller.abort());
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			if (started) return;
			buffer += chunk;
			if (buffer.length > 1024 * 1024) {
				socket.destroy();
				return;
			}
			if (!buffer.includes("\n")) return;
			started = true;
			const execute = async () => {
				let value: unknown;
				try {
					value = JSON.parse(buffer);
				} catch {
					throw new Error("Invalid worker JSON");
				}
				if (!record(value) || value["token"] !== token || !record(value["args"]))
					throw new Error("Unauthorized worker request");
				active++;
				try {
					return await engine.dispatch(text(value["operation"]), value["args"], controller.signal);
				} finally {
					active--;
					lastUsed = Date.now();
					await engine.save(statePath);
				}
			};
			void execute().then(
				(output) => socket.end(`${JSON.stringify({ output })}\n`),
				(error: unknown) => socket.end(`${JSON.stringify({ error: message(error) })}\n`),
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	await writeFile(join(dir, "ready"), String(process.pid));
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		clearInterval(timer);
		server.close();
		await engine.close();
		await engine.save(statePath);
		await rm(join(dir, "ready"), { force: true });
		await rm(join(dir, "lock"), { force: true, recursive: true });
		process.exit(0);
	};
	const timer = setInterval(() => {
		if (!active && Date.now() - lastUsed > 120000) void close();
	}, 10000);
	process.once("SIGTERM", () => void close());
	process.once("SIGINT", () => void close());
}
