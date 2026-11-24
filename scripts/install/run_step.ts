/**
 * Child-process helper for the install reporter.
 *
 * Captures stdout+stderr together so a failing step can replay exactly what the
 * user would have seen, while a succeeding step stays silent. Under --verbose
 * stdio is inherited instead and the captured text comes back empty.
 */

import { spawn } from "node:child_process";

import { child_stdio, get_verbose } from "./reporter";

export type step_result = { code: number; output: string; };

export function run_captured(cmd: string, args: string[], opts?: { cwd?: string; }): Promise<step_result> {
	return new Promise((resolve) => {
		const stdio = child_stdio();
		const child = spawn(cmd, args, { stdio, cwd: opts?.cwd });

		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });

		child.on("error", (err) => { resolve({ code: -1, output: `${output}${err.message}` }); });
		child.on("exit", (code) => { resolve({ code: code ?? -1, output }); });
	});
}

/**
 * Run a child on the parent's stdio. Used for the prerequisites step, which
 * renders its own reporter lines and therefore needs the real terminal.
 */
export function run_inherited(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: "inherit" });
		child.on("error", () => resolve(-1));
		child.on("exit", (code) => resolve(code ?? -1));
	});
}

/** Run a command and return trimmed stdout, or null if it could not run. */
export function run_capture_text(cmd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { stdio: "pipe" });
		} catch {
			return resolve(null);
		}

		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
		child.on("error", () => resolve(null));
		child.on("exit", (code) => { resolve(code === 0 ? out.trim() : null); });
	});
}

/** Forward --verbose to a child script so nested steps stay in the same mode. */
export function with_verbose_flag(args: string[]): string[] {
	const is_verbose = get_verbose();
	if (!is_verbose) return args;
	return [...args, "--verbose"];
}
