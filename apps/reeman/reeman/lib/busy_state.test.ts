import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { any_busy, clear_all_busy, clear_busy, get_busy, GLOBAL_BUSY_KEY, set_busy } from "./busy_state";

const temp_files: string[] = [];

function create_temp_file(): string {
	const file = join(tmpdir(), `reeman-busy-test-${process.pid}-${Bun.randomUUIDv7()}.json`);
	temp_files.push(file);
	return file;
}

	describe("per-target busy state", () => {
		afterAll(async () => {
			await Promise.all(temp_files.map((file) => rm(file, { force: true })));
		});

		test("any_busy prunes a foreign-pid entry from disk", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			// An entry orphaned by a cold restart: its owning process is gone, so
			// nothing will ever run its onExit to clear it.
			await Bun.write(file, JSON.stringify({
				frameworks: { action: "crud", target: "frameworks", started: new Date().toISOString(), pid: process.pid + 99999 },
			}));

			expect(await any_busy(file)).toBeNull();

			const remaining = JSON.parse(await Bun.file(file).text());
			expect(Object.keys(remaining)).toEqual([]);
		});

		test("any_busy leaves a live entry on disk untouched", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			await set_busy("sessions", { action: "crud", target: "sessions" }, file);

			const before = await Bun.file(file).text();
			expect(await any_busy(file)).not.toBeNull();
			const after = await Bun.file(file).text();

			expect(after).toBe(before);

			await clear_busy("sessions", file);
		});

		test("set_busy drops unrelated stale keys while acquiring", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			await Bun.write(file, JSON.stringify({
				frameworks: { action: "crud", target: "frameworks", started: new Date().toISOString(), pid: process.pid + 99999 },
			}));

			expect(await set_busy("sessions", { action: "crud", target: "sessions" }, file)).toBe(true);

			const remaining = JSON.parse(await Bun.file(file).text());
			expect(Object.keys(remaining).sort()).toEqual(["sessions"]);

			await clear_busy("sessions", file);
		});

		test("get_busy returns null when nothing is busy", async () => {
			const file = create_temp_file();
			expect(await get_busy("sessions", file)).toBeNull();
		});

		test("set_busy locks one key without affecting another", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			expect(await set_busy("sessions", { action: "crud", target: "sessions" }, file)).toBe(true);

			expect(await get_busy("sessions", file)).not.toBeNull();
			expect(await get_busy("files", file)).toBeNull();

			await clear_busy("sessions", file);
		});

		test("set_busy on an already-busy key fails and does not overwrite", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			expect(await set_busy("sessions", { action: "crud", target: "sessions" }, file)).toBe(true);
			expect(await set_busy("sessions", { action: "schema", target: "sessions" }, file)).toBe(false);

			const entry = await get_busy("sessions", file);
			expect(entry?.action).toBe("crud");

			await clear_busy("sessions", file);
		});

		test("global lock blocks every key, but a per-key lock does not block other keys", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			expect(await set_busy(GLOBAL_BUSY_KEY, { action: "sync-translations", target: "" }, file)).toBe(true);

			expect(await set_busy("sessions", { action: "crud", target: "sessions" }, file)).toBe(false);
			expect(await get_busy("sessions", file)).not.toBeNull();

			await clear_busy(GLOBAL_BUSY_KEY, file);
		});

		test("clear_busy releases a key so it can be re-acquired", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			await set_busy("sessions", { action: "crud", target: "sessions" }, file);
			await clear_busy("sessions", file);

			expect(await get_busy("sessions", file)).toBeNull();
			expect(await set_busy("sessions", { action: "crud", target: "sessions" }, file)).toBe(true);

			await clear_busy("sessions", file);
		});

		test("any_busy reports any active key", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			expect(await any_busy(file)).toBeNull();

			await set_busy("files", { action: "crud", target: "files" }, file);
			const entry = await any_busy(file);
			expect(entry?.target).toBe("files");

			await clear_all_busy(file);
		});

		test("clear_all_busy empties every key", async () => {
			const file = create_temp_file();
			await set_busy("a", { action: "crud", target: "a" }, file);
			await set_busy("b", { action: "crud", target: "b" }, file);
			await clear_all_busy(file);

			expect(await get_busy("a", file)).toBeNull();
			expect(await get_busy("b", file)).toBeNull();
		});

		test("a foreign-pid entry from a previous process is treated as stale", async () => {
			const file = create_temp_file();
			await clear_all_busy(file);
			await Bun.write(file, JSON.stringify({
				translations: {
					action: "bulk",
					target: "translations",
					started: new Date().toISOString(),
					pid: process.pid + 99999,
				},
			}));

			// A cold restart orphans the entry: it must not keep the UI busy, and
			// the key must be immediately re-acquirable.
			expect(await any_busy(file)).toBeNull();
			expect(await get_busy("translations", file)).toBeNull();
			expect(await set_busy("translations", { action: "crud", target: "translations" }, file)).toBe(true);

			await clear_all_busy(file);
		});
	});
