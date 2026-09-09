import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "./files.js";

const instance = `${process.pid}-${randomUUID()}`;
let queue: Promise<void> = Promise.resolve();
// Only fixed event names: never exception text, source, environment values or configuration.
export function logEvent(
	event: "startup-failure" | "abnormal-exit" | "timeout" | "cancel-cleanup-failure",
): Promise<void> {
	queue = queue
		.then(async () => {
			const dir = join(
				process.env["CODEX_LSP_CACHE"] ??
					join(tmpdir(), `codex-lsp-${process.getuid?.() ?? hash(homedir()).slice(0, 10)}`),
				"logs-v4",
			);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const path = join(dir, `${instance}.log`);
			if ((await stat(path).catch(() => ({ size: 0 }))).size + 100 > 1024 * 1024) {
				await rm(`${path}.1`, { force: true });
				await rename(path, `${path}.1`);
			}
			await appendFile(path, `${new Date().toISOString()} ${event}\n`, { mode: 0o600 });
		})
		.catch(() => undefined);
	return queue;
}
