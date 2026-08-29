import { describe, expect, test } from "bun:test";

const { sqlite_insert_statements, sqlite_literal, timestamped_backup_filename } = await import("./database_backup");

describe("database backups", () => {
	test("uses a readable filesystem-safe timestamp in the filename", () => {
		expect(timestamped_backup_filename(new Date("2026-08-24T12:34:56.789Z"))).toBe("backup-2026-08-24T12-34-56-789Z.sql");
	});

	test("batches SQLite rows into bounded multi-row inserts", () => {
		const columns = [{ name: "id", hidden: 0 }, { name: "name", hidden: 0 }];
		const rows = Array.from({ length: 101 }, (_, id) => ({ id, name: `name-${id}` }));
		const statements = sqlite_insert_statements("users", columns, rows);
		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain("VALUES\n(0, 'name-0')");
		expect(statements[0]).toContain("(99, 'name-99');");
		expect(statements[1]).toContain("(100, 'name-100');");
	});

	test("serializes SQLite values as SQL literals", () => {
		expect(sqlite_literal(null)).toBe("NULL");
		expect(sqlite_literal(true)).toBe("1");
		expect(sqlite_literal(42)).toBe("42");
		expect(sqlite_literal("O'Reilly")).toBe("'O''Reilly'");
		expect(sqlite_literal(new Uint8Array([0, 15, 255]))).toBe("X'000fff'");
	});
});
