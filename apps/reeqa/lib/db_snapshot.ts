import { join } from "node:path";

import type { Qa_project } from "./project_store";

const RESET_SCRIPT = "db:clone-test";

type Package_manifest = { scripts?: Record<string, string> };

async function read_manifest(project_path: string): Promise<Package_manifest | undefined> {
	const manifest_file = Bun.file(join(project_path, "package.json"));
	if (!(await manifest_file.exists())) return undefined;
	try {
		const value = await manifest_file.json() as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return value as Package_manifest;
	} catch {
		return undefined;
	}
}

/** Whether the project declares the `db:clone-test` script that backs this flow. */
export async function project_declares_reset(project: Qa_project): Promise<boolean> {
	const manifest = await read_manifest(project.path);
	return Boolean(manifest?.scripts && typeof manifest.scripts[RESET_SCRIPT] === "string");
}

async function run_db_script(project: Qa_project, args: string[]): Promise<string> {
	const proc = Bun.spawn(["bun", "run", RESET_SCRIPT, "--", ...args], {
		cwd: project.path,
		env: { ...Bun.env, CI: "1", NO_COLOR: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exit_code = await proc.exited;
	if (exit_code !== 0) {
		const detail = Bun.stripANSI(`${stdout}\n${stderr}`.trim());
		throw new Error(`db:clone-test failed: ${detail}`);
	}
	return Bun.stripANSI(`${stdout}\n${stderr}`.trim());
}

/**
 * Clone dev -> test DB (the declared reset), then snapshot the test DB to
 * `file_path`. Returns false when the project has no `db:clone-test` script,
 * in which case nothing is cloned or snapshotted.
 */
export async function reset_and_snapshot(project: Qa_project, file_path: string): Promise<boolean> {
	if (!(await project_declares_reset(project))) return false;
	await run_db_script(project, ["--yes", "--quiet"]);
	await run_db_script(project, ["--snapshot", file_path]);
	return true;
}

/** Restore a snapshot file into the test DB. Returns false when the project has no `db:clone-test` script. */
export async function restore_snapshot(project: Qa_project, file_path: string): Promise<boolean> {
	if (!(await project_declares_reset(project))) return false;
	await run_db_script(project, ["--restore", file_path]);
	return true;
}
