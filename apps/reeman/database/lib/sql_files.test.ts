import { describe, expect, test } from "bun:test";

import { group_demo_files, is_studio_editable_path, studio_url, type SqlFileInfo } from "./sql_files";

describe("studio SQL file groups", () => {
	test("groups file options by containing folder", () => {
		const files: SqlFileInfo[] = [
			{ path: "sql/sqlite/demos/05-frameworks.sql", dialect: "sqlite", group: "sql/sqlite/demos", name: "05-frameworks.sql" },
			{ path: "sql/sqlite/demos/06-init-books.sql", dialect: "sqlite", group: "sql/sqlite/demos", name: "06-init-books.sql" },
			{ path: "sql/mysql/demos/05-frameworks.sql", dialect: "mysql", group: "sql/mysql/demos", name: "05-frameworks.sql" },
		];

		const groups = group_demo_files(files);

		expect(groups).toEqual([
			{ group: "sql/sqlite/demos", files: files.slice(0, 2) },
			{ group: "sql/mysql/demos", files: files.slice(2) },
		]);
	});
});

describe("studio SQL file editability", () => {
	test("uses dynamic editable roots instead of fixed filenames", () => {
		expect(is_studio_editable_path("sql/sqlite/demos/new-example.sql")).toBe(true);
		expect(is_studio_editable_path("sql\\sqlite\\demos\\new-example.sql")).toBe(true);
		expect(is_studio_editable_path("sql/mysql/demos/new-example.sql")).toBe(true);
		expect(is_studio_editable_path("sql/sqlite/app/06-init-teams.sql")).toBe(true);
		expect(is_studio_editable_path("sql/sqlite/init/02-init-translations-table.sql")).toBe(false);
		expect(is_studio_editable_path("sql/sqlite/init/03-init-translations-en-us.sql")).toBe(false);
		expect(is_studio_editable_path("sql/sqlite/init/01-init-sqlite.sql")).toBe(false);
		expect(is_studio_editable_path("sql\\sqlite\\init\\01-init-sqlite.sql")).toBe(false);
		expect(is_studio_editable_path("../sql/sqlite/demos/escape.sql")).toBe(false);
		expect(studio_url("sql\\sqlite\\demos\\new-example.sql")).toBe("/studio?path=sql%5Csqlite%5Cdemos%5Cnew-example.sql");
	});
});
