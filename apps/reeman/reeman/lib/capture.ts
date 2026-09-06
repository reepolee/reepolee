/**
 * Console capture for in-process reeman web actions.
 *
 * Mirrors scripts/mcp/operations.ts: wraps console.log/error/warn while the
 * action runs, collects the lines for display in the web UI, and forwards
 * them to the real console so the terminal still shows generator output.
 */

export function capture_output<T>(fn: () => Promise<T>): { stdout: string[]; stderr: string[]; fn: () => Promise<T>; } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const orig_log = console.log;
	const orig_error = console.error;
	const orig_warn = console.warn;

	const line = (msgs: unknown[]): string => msgs.map((m) => (typeof m === "string" ? m : Bun.inspect(m))).join(" ");

	console.log = (...msgs) => {
		stdout.push(line(msgs));
		orig_log(...msgs);
	};
	console.error = (...msgs) => {
		stderr.push(line(msgs));
		orig_error(...msgs);
	};
	console.warn = (...msgs) => {
		stdout.push(line(msgs));
		orig_warn(...msgs);
	};

	const wrapped = async () => {
		try {
			return await fn();
		} finally {
			console.log = orig_log;
			console.error = orig_error;
			console.warn = orig_warn;
		}
	};

	return { stdout, stderr, fn: wrapped };
}

/** Strip ANSI colour codes and trim, so captured generator output is readable in HTML. */
export function clean_output(lines: string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "").trim();
}
