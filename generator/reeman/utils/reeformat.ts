#!/usr/bin/env bun
/**
 * Formatting helpers - run reettier on generated directories.
 */

import { spawnSync } from "bun";

import { color, dim, RED } from "../ui";

/**
 * Run reettier on the given directories. Skips if no directories are provided.
 */
export function run_reettier(...dirs): void {
	if (dirs.length === 0) return;

	for (const dir of dirs) {
		console.log(`  ${dim("reettier")} ${dir}`);
		try {
			const { exit_code } = spawnSync({
				cmd: ["reettier", dir],
				stdio: ["inherit", "inherit", "inherit"],
			});
			if (exit_code !== 0) { console.error(`  ${color("reettier exited with code", RED)} ${exit_code}`); }
		} catch (err) {
			console.error(`  ${color("reettier error:", RED)} ${err instanceof Error ? err.message : err}`);
		}
	}
}
