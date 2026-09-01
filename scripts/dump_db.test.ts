import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dump_dialect, mysql_dump_command, run_dump, sqlite_database_path, timestamped_backup_directory, timestamped_backup_folder } from "./dump_db";

describe("database dump helpers", () => {
	test("uses a filesystem-safe timestamped backup folder", () => {
		expect(timestamped_backup_folder(new Date("2026-08-24T12:34:56.789Z"))).toBe("backup-2026-08-24T12-34-56-789Z");
		expect(timestamped_backup_directory("C:/project", new Date("2026-08-24T12:34:56.789Z"))).toBe(join("C:/project", ".reepolee", "backup-2026-08-24T12-34-56-789Z"));
	});

	test("builds mysqldump arguments from a MySQL connection string", () => {
		const result = mysql_dump_command("mysql://dump_user:p%40ss@db.example:3307/iot_db");
		expect(result.password).toBe("p@ss");
		expect(result.cmd).toEqual([
			"mysqldump",
			"--host=db.example",
			"--port=3307",
			"--user=dump_user",
			"--no-create-db",
			"--single-transaction",
			"--quick",
			"--extended-insert",
			"--triggers",
			"--routines",
			"--events",
			"--hex-blob",
			"iot_db",
		]);
	});

	test("parses SQLite file connection strings and dialects", () => {
		expect(sqlite_database_path("sqlite://data/dev.db")).toBe("data/dev.db");
		expect(dump_dialect("mysql://localhost/iot_db")).toBe("mysql");
		expect(dump_dialect("sqlite://data/dev.db")).toBe("sqlite");
	});

	test("copies SQLite database files into the requested backup folder", async () => {
		const temporary_dir = await mkdtemp(join(tmpdir(), "reepolee-dump-test-"));
		const source_path = join(temporary_dir, "dev.db");
		const output_dir = join(temporary_dir, "backup-2026-09-01T00-00-00-000Z");
		const source_bytes = new Uint8Array([0, 1, 2, 255]);
		try {
			await Bun.write(source_path, source_bytes);
			await run_dump({ connection: `sqlite://${source_path}`, dialect: "sqlite", output_dir });
			expect(await Bun.file(join(output_dir, "dev.db")).bytes()).toEqual(source_bytes);
		} finally {
			await rm(temporary_dir, { recursive: true, force: true });
		}
	});
});
