import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Engine } from "./engine.js";

export class Runtime {
	private readonly engines = new Map<string, Engine>();
	private readonly active = new Map<string, number>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	async request(root: string, operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		if (!isAbsolute(root)) throw new Error("workspace must be an absolute project directory");
		root = await realpath(root);
		signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
		signal.throwIfAborted();
		let engine = this.engines.get(root);
		if (!engine) {
			engine = new Engine(root);
			this.engines.set(root, engine);
		}
		clearTimeout(this.timers.get(root));
		this.active.set(root, (this.active.get(root) ?? 0) + 1);
		try {
			return await engine.dispatch(operation, args, signal);
		} finally {
			const active = (this.active.get(root) ?? 1) - 1;
			this.active.set(root, active);
			if (!active) {
				const target = engine;
				const timer = setTimeout(() => {
					void target.dispatch("release", {}, new AbortController().signal);
				}, 120000);
				timer.unref();
				this.timers.set(root, timer);
			}
		}
	}
	async close(): Promise<void> {
		for (const timer of this.timers.values()) clearTimeout(timer);
		await Promise.all([...this.engines.values()].map((engine) => engine.dispose()));
		this.engines.clear();
	}
}
