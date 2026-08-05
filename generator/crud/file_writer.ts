/**
 * File Writer - handles safe file writing with interactive overwrite prompts.
 */

import { mkdirSync } from "node:fs";

import { spawnSync } from "bun";

/**
 * Create a safe file writer that prompts the user before overwriting existing files.
 */
export function create_safe_writer(force: boolean) {
	let global_overwrite: boolean | null = null;

	async function safe_write(file_path: string, content: string): Promise<void> {
		const file_exists = await Bun.file(file_path).exists();

		if (!file_exists) {
			await Bun.write(file_path, content);
			console.log(`✓ Generated ${file_path}`);
			return;
		}

		if (force) {
			await Bun.write(file_path, content);
			console.log(`✓ Overwrote  ${file_path} (--force)`);
			return;
		}

		if (global_overwrite === null) {
			process.stdout.write("\n⚠  Folder already contains files. Overwrite ALL? [y/N] ");
			const response = prompt("");
			global_overwrite = response?.toLowerCase() === "y";
			console.log();
		}

		if (global_overwrite) {
			await Bun.write(file_path, content);
			console.log(`✓ Overwrote  ${file_path}`);
		} else {
			console.log(`⊘ Skipped    ${file_path}`);
		}
	}

	return safe_write;
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
