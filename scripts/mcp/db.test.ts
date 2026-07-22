import { describe, expect, test } from "bun:test";

import { db_type } from "$lib/resolve_db_type";

import { prepare_read_only_query, run_read_only_query } from "./db";

describe("MCP read-only SQL", () => {
	test("accepts a SELECT query and applies a result cap", () => {
		expect(prepare_read_only_query("SELECT 1 AS value", 10)).toBe("SELECT * FROM (SELECT 1 AS value) AS mcp_query LIMIT 11");
	});

	// For SQLite, the inspection connection reuses the main DB connection in
	// read-only mode. For MySQL, an explicit MCP_READONLY_CONNECTION_STRING
	// env var is required — skip if not available.
	const run_query = db_type === "sqlite" || !!Bun.env.MCP_READONLY_CONNECTION_STRING ? test : test.skip;

	run_query("executes an approved read query through the inspection connection", async () => {
		const result = await run_read_only_query("SELECT 1 AS value");
		expect(result.rows).toEqual([{ value: 1 }]);
	});

	test("rejects mutation statements and multi-statement input", () => {
		for (const query of [
			"DELETE FROM users",
			"UPDATE users SET name = 'x'",
			"INSERT INTO users (name) VALUES ('x')",
			"CREATE TABLE leaked (id INTEGER)",
			"ALTER TABLE users ADD COLUMN leaked TEXT",
			"DROP TABLE users",
			"PRAGMA writable_schema = ON",
			"SELECT 1; DELETE FROM users",
			"SELECT load_file('/etc/passwd')",
			"SELECT 1 INTO OUTFILE '/tmp/reepolee.sql'",
		]) {
			expect(() => prepare_read_only_query(query)).toThrow();
		}
	});
});
