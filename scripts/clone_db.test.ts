import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mysql_restore_command, regenerate_test_database } from "./clone_db";

describe("test database regeneration", () => {
	test("builds mysql restore arguments from the target connection", () => {
		const result = mysql_restore_command("mysql://restore_user:p%40ss@db.example:3307/iot_test");
		expect(result.password).toBe("p@ss");
		expect(result.cmd).toEqual([
			"mysql",
			"--host=db.example",
			"--port=3307",
			"--user=restore_user",
			"iot_test",
		]);
	});

	test("replaces a SQLite test database from the copied dump file", async () => {
		const temporary_dir = await mkdtemp(join(tmpdir(), "reepolee-clone-test-"));
		const source_path = join(temporary_dir, "development.db");
		const target_path = join(temporary_dir, "application_test.db");
		const source_connection = `sqlite:${source_path}`;
		const target_connection = `sqlite:${target_path}`;
		try {
			const source_db = new SQL(source_connection);
			await source_db.unsafe("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
			await source_db.unsafe("CREATE VIEW item_labels AS SELECT label FROM items");
			await source_db.unsafe("INSERT INTO items (label) VALUES ('fresh')");
			await source_db.close();

			const stale_db = new SQL(target_connection);
			await stale_db.unsafe("CREATE TABLE stale_items (id INTEGER PRIMARY KEY)");
			await stale_db.close();

			const summary = await regenerate_test_database({ source_connection, target_connection });
			expect(summary).toEqual({ tables: 1, rows: 1 });

			const target_db = new SQL(target_connection);
			const item_rows = await target_db.unsafe("SELECT label FROM items") as Array<{ label: string }>;
			const stale_rows = await target_db.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stale_items'");
			const view_rows = await target_db.unsafe("SELECT label FROM item_labels") as Array<{ label: string }>;
			expect(item_rows).toEqual([{ label: "fresh" }]);
			expect(stale_rows).toEqual([]);
			expect(view_rows).toEqual([{ label: "fresh" }]);
			await target_db.close();
		} finally {
			await rm(temporary_dir, { recursive: true, force: true });
		}
	});

	test("keeps SQLite schema and removes data in no-data mode", async () => {
		const temporary_dir = await mkdtemp(join(tmpdir(), "reepolee-clone-schema-test-"));
		const source_path = join(temporary_dir, "development.db");
		const target_path = join(temporary_dir, "schema_test.db");
		const source_connection = `sqlite:${source_path}`;
		const target_connection = `sqlite:${target_path}`;
		try {
			const source_db = new SQL(source_connection);
			await source_db.unsafe("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
			await source_db.unsafe("CREATE INDEX items_label_idx ON items (label)");
			await source_db.unsafe("CREATE VIEW item_labels AS SELECT label FROM items");
			await source_db.unsafe("INSERT INTO items (label) VALUES ('excluded')");
			await source_db.close();

			const summary = await regenerate_test_database({ source_connection, target_connection, no_data: true });
			expect(summary).toEqual({ tables: 1, rows: 0 });

			const target_db = new SQL(target_connection);
			const item_rows = await target_db.unsafe("SELECT label FROM items");
			const index_rows = await target_db.unsafe("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'items_label_idx'");
			const view_rows = await target_db.unsafe("SELECT label FROM item_labels");
			expect(item_rows).toEqual([]);
			expect(index_rows).toHaveLength(1);
			expect(view_rows).toEqual([]);
			await target_db.close();
		} finally {
			await rm(temporary_dir, { recursive: true, force: true });
		}
	});
});
