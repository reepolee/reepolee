import { afterAll, describe, expect, test } from "bun:test";

import { any_busy, clear_all_busy, clear_busy, get_busy, GLOBAL_BUSY_KEY, set_busy } from "./busy_state";

const TMP_FILE = `/tmp/reeman-busy-test-${process.pid}-${Date.now()}.json`;

describe("per-target busy state", () => {
	afterAll(async () => {
		try {
			await Bun.spawn(["rm", "-f", TMP_FILE]).exited;
		} catch {
			// best-effort cleanup
		}
	});

	test("any_busy prunes a foreign-pid entry from disk", async () => {
		await clear_all_busy(TMP_FILE);
		// An entry orphaned by a cold restart: its owning process is gone, so
		// nothing will ever run its onExit to clear it.
		await Bun.write(TMP_FILE, JSON.stringify({
			frameworks: { action: "crud", target: "frameworks", started: new Date().toISOString(), pid: process.pid + 99999 },
		}));

		expect(await any_busy(TMP_FILE)).toBeNull();

		const remaining = JSON.parse(await Bun.file(TMP_FILE).text());
		expect(Object.keys(remaining)).toEqual([]);
	});

	test("any_busy leaves a live entry on disk untouched", async () => {
		await clear_all_busy(TMP_FILE);
		await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE);

		const before = await Bun.file(TMP_FILE).text();
		expect(await any_busy(TMP_FILE)).not.toBeNull();
		const after = await Bun.file(TMP_FILE).text();

		expect(after).toBe(before);

		await clear_busy("sessions", TMP_FILE);
	});

	test("set_busy drops unrelated stale keys while acquiring", async () => {
		await clear_all_busy(TMP_FILE);
		await Bun.write(TMP_FILE, JSON.stringify({
			frameworks: { action: "crud", target: "frameworks", started: new Date().toISOString(), pid: process.pid + 99999 },
		}));

		expect(await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE)).toBe(true);

		const remaining = JSON.parse(await Bun.file(TMP_FILE).text());
		expect(Object.keys(remaining).sort()).toEqual(["sessions"]);

		await clear_busy("sessions", TMP_FILE);
	});

	test("get_busy returns null when nothing is busy", async () => {
		expect(await get_busy("sessions", TMP_FILE)).toBeNull();
	});

	test("set_busy locks one key without affecting another", async () => {
		await clear_all_busy(TMP_FILE);
		expect(await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE)).toBe(true);

		expect(await get_busy("sessions", TMP_FILE)).not.toBeNull();
		expect(await get_busy("files", TMP_FILE)).toBeNull();

		await clear_busy("sessions", TMP_FILE);
	});

	test("set_busy on an already-busy key fails and does not overwrite", async () => {
		await clear_all_busy(TMP_FILE);
		expect(await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE)).toBe(true);
		expect(await set_busy("sessions", { action: "schema", target: "sessions" }, TMP_FILE)).toBe(false);

		const entry = await get_busy("sessions", TMP_FILE);
		expect(entry?.action).toBe("crud");

		await clear_busy("sessions", TMP_FILE);
	});

	test("global lock blocks every key, but a per-key lock does not block other keys", async () => {
		await clear_all_busy(TMP_FILE);
		expect(await set_busy(GLOBAL_BUSY_KEY, { action: "sync-translations", target: "" }, TMP_FILE)).toBe(true);

		expect(await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE)).toBe(false);
		expect(await get_busy("sessions", TMP_FILE)).not.toBeNull();

		await clear_busy(GLOBAL_BUSY_KEY, TMP_FILE);
	});

	test("clear_busy releases a key so it can be re-acquired", async () => {
		await clear_all_busy(TMP_FILE);
		await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE);
		await clear_busy("sessions", TMP_FILE);

		expect(await get_busy("sessions", TMP_FILE)).toBeNull();
		expect(await set_busy("sessions", { action: "crud", target: "sessions" }, TMP_FILE)).toBe(true);

		await clear_busy("sessions", TMP_FILE);
	});

	test("any_busy reports any active key", async () => {
		await clear_all_busy(TMP_FILE);
		expect(await any_busy(TMP_FILE)).toBeNull();

		await set_busy("files", { action: "crud", target: "files" }, TMP_FILE);
		const entry = await any_busy(TMP_FILE);
		expect(entry?.target).toBe("files");

		await clear_all_busy(TMP_FILE);
	});

	test("clear_all_busy empties every key", async () => {
		await set_busy("a", { action: "crud", target: "a" }, TMP_FILE);
		await set_busy("b", { action: "crud", target: "b" }, TMP_FILE);
		await clear_all_busy(TMP_FILE);

		expect(await get_busy("a", TMP_FILE)).toBeNull();
		expect(await get_busy("b", TMP_FILE)).toBeNull();
	});

	test("a foreign-pid entry from a previous process is treated as stale", async () => {
		await clear_all_busy(TMP_FILE);
		await Bun.write(TMP_FILE, JSON.stringify({
			translations: {
				action: "bulk",
				target: "translations",
				started: new Date().toISOString(),
				pid: process.pid + 99999,
			},
		}));

		// A cold restart orphans the entry: it must not keep the UI busy, and
		// the key must be immediately re-acquirable.
		expect(await any_busy(TMP_FILE)).toBeNull();
		expect(await get_busy("translations", TMP_FILE)).toBeNull();
		expect(await set_busy("translations", { action: "crud", target: "translations" }, TMP_FILE)).toBe(true);

		await clear_all_busy(TMP_FILE);
	});
});
