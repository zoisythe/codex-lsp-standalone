import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { TextEdit } from "../packages/lsp-tools-mcp/dist/lsp/types.js";

const exec = promisify(execFile);
const SKIP = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".next",
	"coverage",
	".canon",
	".venv",
	".ruff_cache",
	".mypy_cache",
	".pytest_cache",
	"__pycache__",
	"vendor",
	"target",
]);
export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export async function workspacePath(root: string, path: string): Promise<string> {
	const absolute = resolve(root, path);
	if (!inside(root, absolute)) throw new Error("Path is outside workspace");
	const actual = await realpath(absolute);
	if (!inside(root, actual)) throw new Error("Symlink is outside workspace");
	return actual;
}
export interface Inventory {
	files: Map<string, string>;
	version: string;
	complete: boolean;
}
export async function inventory(root: string, maxFiles = 10000): Promise<Inventory> {
	let names: string[];
	let complete = true;
	try {
		const { stdout } = await exec(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
			{ cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
		);
		names = [...new Set(stdout.split("\0").filter(Boolean))];
	} catch {
		names = [];
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (names.length >= maxFiles) {
					complete = false;
					break;
				}
				if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.isFile()) names.push(relative(root, path));
			}
		};
		await walk(root);
	}
	const files = new Map<string, string>();
	names.sort();
	if (names.length > maxFiles) complete = false;
	for (const name of names.slice(0, maxFiles)) {
		if (name.split(/[\\/]/).some((part) => SKIP.has(part))) continue;
		try {
			const path = await workspacePath(root, name);
			const stat = await lstat(path);
			if (!stat.isFile()) continue;
			if (stat.size > 1024 * 1024) {
				complete = false;
				continue;
			}
			files.set(relative(root, path), hash(await readFile(path, "utf8")));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) complete = false;
		}
	}
	return { files, version: hash(JSON.stringify([...files])), complete };
}
export function applyTextChanges(text: string, edits: readonly TextEdit[]): string {
	const lines = text.split("\n");
	const offset = (line: number, character: number): number => {
		if (
			!Number.isInteger(line) ||
			!Number.isInteger(character) ||
			line < 0 ||
			character < 0 ||
			line >= lines.length ||
			character > (lines[line]?.length ?? 0)
		)
			throw new Error("Invalid edit range");
		return lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + character;
	};
	const sorted = edits
		.map((edit) => ({
			start: offset(edit.range.start.line, edit.range.start.character),
			end: offset(edit.range.end.line, edit.range.end.character),
			text: edit.newText,
		}))
		.sort((a, b) => b.start - a.start || b.end - a.end);
	let boundary = text.length;
	for (const edit of sorted) {
		if (edit.start > edit.end || edit.end > boundary) throw new Error("Overlapping edit ranges");
		text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
		boundary = edit.start;
	}
	return text;
}
