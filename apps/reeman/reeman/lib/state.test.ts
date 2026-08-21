import { afterAll, describe, expect, test } from "bun:test";

import { clear_runs, load_runs, record_run, update_run } from "./state";

const TMP_FILE = `/tmp/reeman-state-test-${process.pid}-${Date.now()}.json`;
const MISSING_FILE = "/tmp/reeman-state-file-that-does-not-exist.json";

describe("reeman run log state", () => {
	afterAll(async () => {
		try {
			await Bun.spawn(["rm", "-f", TMP_FILE]).exited;
		} catch {
			// best-effort cleanup
		}
	});

	test("load_runs returns [] when no log file exists", async () => {
		expect(await load_runs(MISSING_FILE)).toEqual([]);
	});

	test("load_runs tolerates corrupt JSON", async () => {
		await Bun.write(TMP_FILE, "not json {");
		expect(await load_runs(TMP_FILE)).toEqual([]);
	});

	test("record_run writes and load_runs reads newest-first", async () => {
		await clear_runs(TMP_FILE);
		await record_run({ action: "crud", target: "frameworks", ok: true, output: "done" }, TMP_FILE);
		await record_run({ action: "schema", target: "users", ok: false, output: "failed", error: "boom" }, TMP_FILE);

		const runs = await load_runs(TMP_FILE);
		expect(runs).toHaveLength(2);
		expect(runs[0]?.action).toBe("schema");
		expect(runs[0]?.ok).toBe(false);
		expect(runs[0]?.error).toBe("boom");
		expect(runs[0]?.id).toBeTruthy();
		expect(runs[1]?.action).toBe("crud");
		expect(runs[1]?.ok).toBe(true);
	});

	test("update_run replaces a pending run with the completed output", async () => {
		await clear_runs(TMP_FILE);
		const id = await record_run({ action: "crud", target: "frameworks", ok: true, output: "Generation started in background." }, TMP_FILE);
		await update_run(id, { ok: false, output: "step one\nstep two", error: "exit code 1" }, TMP_FILE);

		const runs = await load_runs(TMP_FILE);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe(id);
		expect(runs[0]?.ok).toBe(false);
		expect(runs[0]?.output).toBe("step one\nstep two");
		expect(runs[0]?.error).toBe("exit code 1");
	});

	test("clear_runs empties the log", async () => {
		await record_run({ action: "crud", target: "t", ok: true, output: "x" }, TMP_FILE);
		await clear_runs(TMP_FILE);
		expect(await load_runs(TMP_FILE)).toEqual([]);
	});
});
