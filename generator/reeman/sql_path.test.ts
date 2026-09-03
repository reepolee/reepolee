import { describe, expect, test } from "bun:test";

import { join } from "node:path";

import { validate_sql_file_path } from "./sql_path";

describe("validate_sql_file_path", () => {
	test("accepts a dialect sql path and resolves it under the project root", () => {
		const resolved = validate_sql_file_path("sql/mysql/01-init.sql");
		expect(resolved).toBe(join(process.cwd(), "sql", "mysql", "01-init.sql"));
	});

	test("pins the path inside allowed_root when given", () => {
		const root = join(process.cwd(), "sql", "sqlite");
		expect(validate_sql_file_path("sql/sqlite/02-seed.sql", { allowed_root: root }))
			.toBe(join(root, "02-seed.sql"));
		expect(() => validate_sql_file_path("sql/mysql/01-init.sql", { allowed_root: root })).toThrow(/escapes the allowed directory/);
		expect(() => validate_sql_file_path("sql/other/01-init.sql", { allowed_root: root })).toThrow(/escapes the allowed directory/);
	});

	test("rejects absolute paths, traversal, and non-sql files", () => {
		expect(() => validate_sql_file_path("/etc/passwd")).toThrow(/relative/);
		expect(() => validate_sql_file_path("../secrets/creds.sql")).toThrow(/"\.\."/);
		expect(() => validate_sql_file_path("sql/mysql/../../.env")).toThrow(/"\.\."/);
		expect(() => validate_sql_file_path("sql/mysql/01-init.txt")).toThrow(/Only \.sql files/);
		expect(() => validate_sql_file_path("")).toThrow(/No SQL file selected/);
	});

	test("rejects sql extensions smuggled after a traversal", () => {
		expect(() => validate_sql_file_path("sql/mysql/../../evil.sql")).toThrow(/"\.\."/);
	});
});
