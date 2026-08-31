import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clear_runs, load_runs, record_run, update_run } from "./state";

const MISSING_FILE = "/tmp/reeman-state-file-that-does-not-exist.json";
const temp_dirs: string[] = [];

async function create_temp_file(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "reeman-state-test-"));
	temp_dirs.push(dir);
	return join(dir, "state.json");
}

describe("reeman run log state", () => {
	afterAll(async () => {
		await Promise.all(temp_dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test("load_runs returns [] when no log file exists", async () => {
		expect(await load_runs(MISSING_FILE)).toEqual([]);
	});

	test("load_runs tolerates corrupt JSON", async () => {
		const file = await create_temp_file();
		await Bun.write(file, "not json {");
		expect(await load_runs(file)).toEqual([]);
	});

	test("record_run writes and load_runs reads newest-first", async () => {
		const file = await create_temp_file();
		await clear_runs(file);
		await record_run({ action: "crud", target: "frameworks", ok: true, output: "done" }, file);
		await record_run({ action: "schema", target: "users", ok: false, output: "failed", error: "boom" }, file);

		const runs = await load_runs(file);
		expect(runs).toHaveLength(2);
		expect(runs[0]?.action).toBe("schema");
		expect(runs[0]?.ok).toBe(false);
		expect(runs[0]?.error).toBe("boom");
		expect(runs[0]?.id).toBeTruthy();
		expect(runs[1]?.action).toBe("crud");
		expect(runs[1]?.ok).toBe(true);
	});

	test("update_run replaces a pending run with the completed output", async () => {
		const file = await create_temp_file();
		await clear_runs(file);
		const id = await record_run({ action: "crud", target: "frameworks", ok: true, output: "Generation started in background." }, file);
		await update_run(id, { ok: false, output: "step one\nstep two", error: "exit code 1" }, file);

		const runs = await load_runs(file);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe(id);
		expect(runs[0]?.ok).toBe(false);
		expect(runs[0]?.output).toBe("step one\nstep two");
		expect(runs[0]?.error).toBe("exit code 1");
	});

	test("clear_runs empties the log", async () => {
		const file = await create_temp_file();
		await record_run({ action: "crud", target: "t", ok: true, output: "x" }, file);
		await clear_runs(file);
		expect(await load_runs(file)).toEqual([]);
	});
});
