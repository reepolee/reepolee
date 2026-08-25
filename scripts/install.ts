#!/usr/bin/env bun

/**
 * Non-interactive project bootstrap for a true bun create destination.
 * Bun removes package.json's bun-create section only from generated projects,
 * so source repositories and normal clones exit before any mutation. A marker
 * prevents a generated project from being re-seeded on later bun installs.
 *
 * Child steps are captured rather than inherited so this can present one line
 * per step instead of each script's own log format. Pass --verbose
 * (`bun run reepolee:install --verbose`) to stream the raw child output.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { heading, note, section, set_verbose, step_done, step_fail, step_start, success } from "./install/reporter";
import { run_captured, run_inherited, with_verbose_flag } from "./install/run_step";

/** Run a child step, reporting one line and aborting on failure. */
async function run_step(label: string, args: string[], detail?: string): Promise<string> {
	step_start(label);
	const result = await run_captured("bun", args);
	if (result.code !== 0) {
		step_fail(label, result.output);
		throw new Error(`${label} failed with exit code ${result.code}`);
	}
	step_done(label, detail);
	return result.output.trim();
}

async function is_bun_create_destination(pkg_path: string): Promise<boolean> {
	const pkg = await Bun.file(pkg_path).json();
	return !Object.hasOwn(pkg, "bun-create");
}

async function main() {
	const args = process.argv.slice(2);
	const is_verbose = args.includes("--verbose");
	set_verbose(is_verbose);

	const marker_dir = join(process.cwd(), ".reepolee");
	const marker_path = join(marker_dir, "marker");
	const pkg_path = join(process.cwd(), "package.json");

	if (!existsSync(pkg_path)) { throw new Error("package.json not found in the current directory"); }
	const is_bun_create = await is_bun_create_destination(pkg_path);
	if (!is_bun_create) {
		note("source checkout - bootstrap skipped");
		return;
	}

	if (existsSync(marker_path)) {
		note("already bootstrapped - skipping");
		return;
	}

	const project_name = process.cwd().split(/[/\\]/).pop() ?? "your app";

	heading("reepolee");

	// Prerequisites draw their own section and per-tool lines, so this child
	// gets the terminal directly instead of being captured like the others.
	const prereq_args = with_verbose_flag(["scripts/install/prerequisites.ts"]);
	const prereq_code = await run_inherited("bun", prereq_args);
	if (prereq_code !== 0) { throw new Error(`prerequisites failed with exit code ${prereq_code}`); }

	// Commit downloaded vendor/static files so bun create destinations
	// have them in version control.
	try {
		const git_add = await run_captured("git", ["add", "vendor/", "static/"]);
		if (git_add.code === 0) {
			const git_status = await run_captured("git", ["status", "--porcelain", "vendor/", "static/"]);
			if (git_status.output.trim().length > 0) {
				await run_step("git commit", ["git", "commit", "-m", "chore: download vendor and static files"], "committed");
			} else {
				note("no vendor changes to commit");
			}
		}
	} catch {
		// Not a git repo or git unavailable — skip commit silently.
	}

	section("Project");

	await run_step("project meta", ["scripts/sync_project_meta.ts"], "synced");
	await run_step("database", ["scripts/init_sqlite_db.ts", "--quiet"], "initialized");

	// clone_db --quiet prints a single "N tables, M rows" line used as the detail.
	step_start("test database");
	const clone = await run_captured("bun", ["scripts/clone_db.ts", "--yes", "--quiet"]);
	if (clone.code !== 0) {
		step_fail("test database", clone.output);
		throw new Error(`test database clone failed with exit code ${clone.code}`);
	}
	const clone_detail = clone.output.trim().split("\n").pop()?.trim();
	step_done("test database", clone_detail);

	// Sequential on purpose: both writers open the same SQLite file, and running
	// them concurrently trips "database is locked".
	step_start("users");
	const bob = await run_captured("bun", ["generator/user", "bob", "bob@example.com", "b", "--modules", "user", "--quiet"]);
	const alice = await run_captured("bun", ["generator/user", "alice", "alice@example.com", "a", "--modules", "system,user", "--quiet"]);
	if (bob.code !== 0 || alice.code !== 0) {
		step_fail("users", `${bob.output}\n${alice.output}`);
		throw new Error("user creation failed");
	}
	step_done("users", "bob, alice");

	mkdirSync(marker_dir, { recursive: true });
	await Bun.write(marker_path, `${new Date().toISOString()}\n`);

	success(`Ready. cd ${project_name} && bun dev`);
}

main().catch((err) => {
	console.error(`\u001b[31m[install] Error: ${err instanceof Error ? err.message : String(err)}\u001b[0m`);
	process.exit(1);
});
