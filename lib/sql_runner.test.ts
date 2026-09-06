import { describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";

import { mock_db } from "$root/test_helpers";

mock.module("$config/db", mock_db);

const { run_sql, run_sql_read_only, split_sql_statements } = await import("./sql_runner");

describe("run_sql (dev SQL runner)", () => {
	test("SELECT returns records and column names in meta", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
			await db.unsafe(`INSERT INTO users (name) VALUES ("a"), ("b")`);

			const result = await run_sql("SELECT id, name FROM users ORDER BY id", db);

			expect(result.records).toEqual([
				{ id: 1, name: "a" },
				{ id: 2, name: "b" },
			]);
			expect(result.meta.columns).toEqual(["id", "name"]);
			expect(result.meta.record_count).toBe(2);
			expect(result.meta.affected_rows).toBeNull();
			expect(result.meta.command).toBe("SELECT");
		} finally {
			await db.close();
		}
	});

	test("SELECT with zero rows returns empty records", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

			const result = await run_sql("SELECT * FROM users", db);

			expect(result.records).toEqual([]);
			expect(result.meta.record_count).toBe(0);
			expect(result.meta.columns).toEqual([]);
		} finally {
			await db.close();
		}
	});

	test("INSERT reports affected_rows and last_insert_id", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

			const result = await run_sql(`INSERT INTO users (name) VALUES ("a")`, db);

			expect(result.records).toEqual([]);
			expect(result.meta.record_count).toBe(0);
			expect(result.meta.affected_rows).toBe(1);
			expect(result.meta.last_insert_id).toBe(1);
			expect(result.meta.command).toBe("INSERT");
		} finally {
			await db.close();
		}
	});

	test("UPDATE reports affected_rows", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
			await db.unsafe(`INSERT INTO users (name) VALUES ("a")`);

			const result = await run_sql(`UPDATE users SET name = "b"`, db);

			expect(result.records).toEqual([]);
			expect(result.meta.affected_rows).toBe(1);
			expect(result.meta.command).toBe("UPDATE");
		} finally {
			await db.close();
		}
	});

	test("DDL returns empty records with a command", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			const result = await run_sql("CREATE TABLE t (x INT)", db);

			expect(result.records).toEqual([]);
			expect(result.meta.record_count).toBe(0);
			expect(result.meta.affected_rows).toBeNull();
			expect(result.meta.command).toBe("CREATE");
		} finally {
			await db.close();
		}
	});

	test("result is JSON-serializable", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE t (x INT)");
			await db.unsafe(`INSERT INTO t (x) VALUES (1)`);

			const parsed = JSON.parse(JSON.stringify(await run_sql("SELECT * FROM t", db))) as { meta: unknown; records: unknown; };

			expect(parsed).toEqual({ meta: { columns: ["x"], record_count: 1, affected_rows: null, last_insert_id: null, command: "SELECT" }, records: [{ x: 1 }] });
		} finally {
			await db.close();
		}
	});
});

describe("run_sql_read_only (guarded runner)", () => {
	test("accepts a SELECT and caps records with truncated flag", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
			for (let i = 1; i <= 5; i++) await db.unsafe(`INSERT INTO t (name) VALUES ("n${i}")`);

			const result = await run_sql_read_only("SELECT id, name FROM t ORDER BY id", db, 2);

			expect(result.records).toEqual([{ id: 1, name: "n1" }, { id: 2, name: "n2" }]);
			expect(result.meta.columns).toEqual(["id", "name"]);
			expect(result.meta.record_count).toBe(2);
			expect(result.truncated).toBe(true);
		} finally {
			await db.close();
		}
	});

	test("within the cap reports truncated false and full records", async () => {
		const db = new SQL("sqlite::memory:");
		try {
			await db.unsafe("CREATE TABLE t (x INT)");
			await db.unsafe(`INSERT INTO t (x) VALUES (1), (2), (3)`);

			const result = await run_sql_read_only("SELECT x FROM t", db);

			expect(result.records).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
			expect(result.meta.record_count).toBe(3);
			expect(result.truncated).toBe(false);
		} finally {
			await db.close();
		}
	});

	test("rejects writes, DDL, and multi-statement input", async () => {
		for (const query of [
			"INSERT INTO t (x) VALUES (1)",
			"UPDATE t SET x = 1",
			"DELETE FROM t",
			"CREATE TABLE t (x INT)",
			"DROP TABLE t",
			"SELECT 1; SELECT 2",
		]) {
			expect(run_sql_read_only(query)).rejects.toThrow();
		}
	});

	test("rejects SELECT file operations", async () => {
		for (const query of [
			"SELECT load_file('/etc/passwd')",
			"SELECT 1 INTO OUTFILE '/tmp/x.sql'",
		]) {
			expect(run_sql_read_only(query)).rejects.toThrow();
		}
	});
});

describe("split_sql_statements", () => {
	test("splits simple statements and drops comment-only lines", () => {
		const sql = `-- header comment
			CREATE TABLE t (x INT);
			INSERT INTO t (x) VALUES (1);
			SELECT * FROM t;`;

		expect(split_sql_statements(sql)).toEqual([
			"CREATE TABLE t (x INT)",
			"INSERT INTO t (x) VALUES (1)",
			"SELECT * FROM t",
		]);
	});

	test("keeps a SQLite CREATE TRIGGER body intact", () => {
		const sql = `CREATE TRIGGER trg AFTER INSERT ON t
			BEGIN
				UPDATE t SET x = x + 1;
			END;
			SELECT 1;`;

		// Lines are trimStart()ed per line, so continuation lines lose indentation.
		expect(split_sql_statements(sql)).toEqual([
			"CREATE TRIGGER trg AFTER INSERT ON t\nBEGIN\nUPDATE t SET x = x + 1;\nEND",
			"SELECT 1",
		]);
	});

	test("mysql dialect uses the plain semicolon split", () => {
		const sql = "SELECT 1; SELECT 2;";

		expect(split_sql_statements(sql, "mysql")).toEqual(["SELECT 1", "SELECT 2"]);
	});

	test("captures a trailing statement without a semicolon", () => {
		expect(split_sql_statements("select * from users")).toEqual(["select * from users"]);
		expect(split_sql_statements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
		expect(split_sql_statements("SELECT 1;")).toEqual(["SELECT 1"]);
	});

	test("returns an empty array for comment-only input", () => {
		expect(split_sql_statements("-- nothing here\n-- still nothing")).toEqual([]);
	});
});
