import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Codex command hooks sanitize inherited environment, including CODEX_HOME. The
// installed bundle location still identifies the owning home unambiguously.
export function restoreInstalledHome(script: string = fileURLToPath(import.meta.url)): void {
	if (process.env["CODEX_HOME"]) return;
	let child = dirname(script);
	for (let parent = dirname(child); parent !== child; parent = dirname(child)) {
		if (basename(parent) === "plugins" && basename(child) === "cache") {
			process.env["CODEX_HOME"] = dirname(parent);
			return;
		}
		child = parent;
	}
}
