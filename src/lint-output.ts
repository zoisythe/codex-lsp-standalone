import { type Finding, record, text } from "./results.js";

function position(value: Record<string, unknown>, content: string): { line: number; column: number } {
	const location = record(value["location"]) ? value["location"] : {};
	const span = location["span"];
	if (Array.isArray(span) && typeof span[0] === "number") {
		const before = Buffer.from(content).subarray(0, span[0]).toString("utf8").split("\n");
		return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
	}
	const start = record(location["start"]) ? location["start"] : {};
	const line = value["line"] ?? location["row"] ?? start["line"];
	const column = value["column"] ?? location["column"] ?? start["column"];
	return { line: typeof line === "number" ? line : 1, column: typeof column === "number" ? column : 1 };
}
function items(runner: string, data: unknown): unknown[] {
	if (runner === "eslint" && Array.isArray(data))
		return data.flatMap((file: unknown) => (record(file) && Array.isArray(file["messages"]) ? file["messages"] : []));
	if (runner === "ruff" && Array.isArray(data)) return data;
	if (runner === "biome" && record(data) && Array.isArray(data["diagnostics"])) {
		const summary = data["summary"];
		if (record(summary) && Number(summary["diagnosticsNotPrinted"]) > 0)
			throw new Error("Lint result truncated; narrow file scope");
		return data["diagnostics"];
	}
	throw new Error("Unexpected lint output");
}
export function parseLint(runner: string, data: unknown, path: string, content: string): Finding[] {
	const findings: Finding[] = [];
	for (const value of items(runner, data)) {
		if (!record(value)) throw new Error("Malformed lint finding");
		const severity = value["severity"];
		if (severity !== undefined && ![1, 2, "error", "warning", "fatal"].includes(severity as string | number))
			continue;
		findings.push({
			path,
			...position(value, content),
			severity: severity === 1 || severity === "warning" ? "warning" : "error",
			source: `${runner}/${text(value["ruleId"], text(value["code"], text(value["category"], "lint")))}`,
			message: text(value["description"], text(value["message"], "Lint finding")),
		});
	}
	return findings;
}
