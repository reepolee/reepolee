import { describe, expect, test } from "bun:test";

import { format_ddl_for_diff } from "./ddl_format";

describe("Studio DDL preview formatting", () => {
	test("normalizes MySQL decimal spacing before diffing", () => {
		const compact = "CREATE TABLE packages (\n    price DECIMAL(18,2)\n);\n";
		const spaced = "CREATE TABLE packages (\n    price DECIMAL(18, 2)\n);\n";
		expect(format_ddl_for_diff(compact, "mysql")).toBe(format_ddl_for_diff(spaced, "mysql"));
	});

	test("keeps SQLite DDL unchanged", () => {
		const ddl = "CREATE TABLE packages (price DECIMAL(18,2));\n";
		expect(format_ddl_for_diff(ddl, "sqlite")).toBe(ddl);
	});
});
