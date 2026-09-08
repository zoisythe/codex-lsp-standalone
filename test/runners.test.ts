import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { formatWithRunner, lint } from "../src/runners.js";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("runs real Biome without modifying code, then explicitly formats it", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-lint-"));
	roots.push(root);
	await symlink(
		resolve("node_modules"),
		join(root, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	await writeFile(
		join(root, "biome.json"),
		JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } }),
	);
	const before = "export function test(){\n  var bad = 1;\n  return 0;\n}\n";
	await writeFile(join(root, "a.js"), before);
	vi.stubEnv("CODEX_LSP_TRUST_PROJECT", "1");
	const result = await lint(root, "a.js", new AbortController().signal);
	expect(result?.state).toBe("complete");
	expect(result?.findings.some((item) => item.line === 2 && item.source.includes("noUnusedVariables"))).toBe(true);
	expect(await readFile(join(root, "a.js"), "utf8")).toBe(before);
	expect(await formatWithRunner(root, "a.js", new AbortController().signal)).toContain("Formatted");
	expect(await readFile(join(root, "a.js"), "utf8")).not.toBe(before);
});
it("does not execute repository tools unless trusted by the user", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-untrusted-"));
	roots.push(root);
	await mkdir(join(root, "home"));
	vi.stubEnv("CODEX_HOME", join(root, "home"));
	vi.stubEnv("CODEX_LSP_TRUST_PROJECT", "0");
	await writeFile(join(root, "biome.json"), "{}");
	await writeFile(join(root, "a.js"), "var bad=1;");
	expect(await lint(root, "a.js", new AbortController().signal)).toBeUndefined();
});
