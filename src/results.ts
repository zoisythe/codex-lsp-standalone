export interface Finding {
	path: string;
	line: number;
	column: number;
	severity: "error" | "warning";
	source: string;
	message: string;
}
export interface FileResult {
	path: string;
	state: "complete" | "pending" | "skipped" | "failed" | "stale";
	findings: Finding[];
	note?: string;
	channels?: { lsp: FileResult["state"]; lint: FileResult["state"] };
}
export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}
export function number(value: unknown, fallback: number, min = 0, max = 10000): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
		throw new Error(`Expected integer ${min}..${max}`);
	return value;
}
export function render(results: FileResult[], limit = 50, byteLimit = 8192, offset = 0): string {
	const lines = [
		...new Set(
			results.flatMap((result) => [
				...(result.channels
					? [
							`${result.path} channels: lsp=${result.channels.lsp} lint=${result.channels.lint}${result.note ? `; ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
						]
					: []),
				...result.findings.map(
					(finding) =>
						`${finding.path}:${finding.line}:${finding.column} ${finding.severity} [${finding.source}] ${finding.message.replace(/\s+/g, " ")}`,
				),
				...(result.state === "complete"
					? []
					: [
							`${result.path} ${result.state}${result.note ? `: ${result.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
						]),
			]),
		),
	].sort((a, b) => a.localeCompare(b));
	const complete = results.every((result) => result.state === "complete");
	const header = `${complete ? "complete" : "partial"}; checked=${results.filter((result) => result.state === "complete").length} pending=${results.filter((result) => result.state === "pending" || result.state === "stale").length} skipped=${results.filter((result) => result.state === "skipped").length} failed=${results.filter((result) => result.state === "failed").length}`;
	let output = header;
	let shown = 0;
	for (const line of lines.slice(offset, offset + limit)) {
		const clipped = line.slice(0, 1000);
		if (Buffer.byteLength(output + clipped) > byteLimit - 180) break;
		output += `\n${clipped}`;
		shown++;
	}
	if (offset + shown < lines.length)
		output += `\n${lines.length - offset - shown} omitted; next offset=${offset + shown}`;
	return output;
}
