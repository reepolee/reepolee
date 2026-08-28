/**
 * File Writer - handles safe file writing with interactive overwrite prompts.
 */

import { mkdirSync } from "node:fs";

import { spawnSync } from "bun";

export type WriteStatus = "created" | "overwritten" | "skipped";
export type WriteOutcome = { path: string; status: WriteStatus; };
export type SafeWriter = ((file_path: string, content: string) => Promise<void>) & { outcomes: WriteOutcome[]; };

/**
 * Create a safe file writer that prompts the user before overwriting existing files.
 *
 * `interactive` controls whether an overwrite prompt may block on stdin. It
 * defaults to "stdin is a TTY", but web/MCP callers pass `false` explicitly so
 * generation never blocks the server's event loop on a prompt nobody can answer.
 * Non-interactive writers skip existing files (same default as answering "n");
 * note this also means piped-stdin scripts (e.g. `echo y | bun reeman ...`)
 * can no longer answer the prompt - pass `--force` there instead.
 */
export function create_safe_writer(force: boolean, interactive: boolean = process.stdin.isTTY === true): SafeWriter {
	let global_overwrite: boolean | null = null;
	const outcomes: WriteOutcome[] = [];

	async function safe_write(file_path: string, content: string): Promise<void> {
		const file_exists = await Bun.file(file_path).exists();

		if (!file_exists) {
			await Bun.write(file_path, content);
			outcomes.push({ path: file_path, status: "created" });
			console.log(`✓ Generated ${file_path}`);
			return;
		}

		if (force) {
			await Bun.write(file_path, content);
			outcomes.push({ path: file_path, status: "overwritten" });
			console.log(`✓ Overwrote  ${file_path} (--force)`);
			return;
		}

		if (global_overwrite === null) {
			if (!interactive) {
				// Never block on stdin - same default as answering "n". Re-run with
				// force to overwrite existing generated files.
				global_overwrite = false;
				console.log("⊘ Existing files skipped (non-interactive) - re-run with force to overwrite");
			} else {
				process.stdout.write("\n⚠  Folder already contains files. Overwrite ALL? [y/N] ");
				const response = prompt("");
				global_overwrite = response?.toLowerCase() === "y";
				console.log();
			}
		}

		if (global_overwrite) {
			await Bun.write(file_path, content);
			outcomes.push({ path: file_path, status: "overwritten" });
			console.log(`✓ Overwrote  ${file_path}`);
		} else {
			outcomes.push({ path: file_path, status: "skipped" });
			console.log(`⊘ Skipped    ${file_path}`);
		}
	}

	const writer = safe_write as SafeWriter;
	writer.outcomes = outcomes;
	return writer;
}

/**
 * Format a set of directories using reettier.
 */
export async function format_dirs(dirs: Set<string>): Promise<void> {
	for (const dir of dirs) {
		console.log(`  Running: reettier ${dir}`);
		try {
			const reettier_result = spawnSync({
				cmd: ["reettier", dir],
				stdio: ["inherit", "inherit", "inherit"],
			});
			if (reettier_result.exitCode !== 0) { console.error("reettier exited with code", reettier_result.exitCode); }
		} catch (err) {
			console.error("Error formatting generated files:", err instanceof Error ? err.message : err);
		}
	}
}

/**
 * Format a single file with reettier.
 */
export async function format_file(file_path: string): Promise<void> {
	try {
		const reettier_result = spawnSync({
			cmd: ["reettier", file_path],
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (reettier_result.exitCode !== 0) { console.error("reettier exited with code", reettier_result.exitCode); }
	} catch (err) {
		console.error("Error formatting file:", err instanceof Error ? err.message : err);
	}
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensure_dir(dir: string): void { mkdirSync(dir, { recursive: true }); }
