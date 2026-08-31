import { describe, expect, test } from "bun:test";

import { apply_column_renames, detect_column_renames } from "./column_rename";
import { parse_ddl_file } from "./ddl_parser";
import type { StudioColumn, StudioTable } from "./types";

describe("apply_column_renames", () => {
	test("rewrites the column list of an INSERT owned by the table", () => {
		const source = [
			"CREATE TABLE points (id INTEGER PRIMARY KEY, team_id INTEGER, category_id TEXT);",
			"insert INTO points (team_id, category_id, rank, points) SELECT id, 'rg', 999,0 FROM teams;",
		].join("\n\n");
		const model = parse_ddl_file(source, "x.sql", "sqlite");

		const touched = apply_column_renames(model, [{ table: "points", from: "category_id", to: "category_code" }]);
		expect(touched).toEqual(["points"]);
		expect(model.statements[1]!.text).toContain("(team_id, category_code, rank, points)");
	});

	test("does not rewrite string literals holding the old name", () => {
		const source = [
			"CREATE TABLE points (id INTEGER PRIMARY KEY, category_id TEXT);",
			"INSERT INTO points (category_id) VALUES ('category_id');",
		].join("\n\n");
		const model = parse_ddl_file(source, "x.sql", "sqlite");

		apply_column_renames(model, [{ table: "points", from: "category_id", to: "category_code" }]);
		expect(model.statements[1]!.text).toContain("(category_code)");
		expect(model.statements[1]!.text).toContain("'category_id'");
	});

	test("rewrites qualified references inside a trigger body", () => {
		const source = [
			"CREATE TABLE points (id INTEGER PRIMARY KEY, ts TEXT);",
			"CREATE TRIGGER after_insert_points AFTER INSERT ON points FOR EACH ROW BEGIN\n"
				+ "    UPDATE points SET ts = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid and ts IS NULL;\nEND;",
		].join("\n\n");
		const model = parse_ddl_file(source, "x.sql", "sqlite");

		apply_column_renames(model, [{ table: "points", from: "ts", to: "created_ts" }]);
		const trigger_text = model.statements[1]!.text;
		expect(trigger_text).toContain("SET created_ts = CURRENT_TIMESTAMP");
		expect(trigger_text).toContain("created_ts IS NULL");
	});

	test("rewrites a view that reads the renamed column", () => {
		const source = [
			"CREATE TABLE points (id INTEGER PRIMARY KEY, category_id TEXT);",
			"CREATE VIEW v_x AS SELECT p.id, p.category_id FROM points p;",
		].join("\n\n");
		const model = parse_ddl_file(source, "x.sql", "sqlite");

		apply_column_renames(model, [{ table: "points", from: "category_id", to: "category_code" }]);
		expect(model.statements[1]!.text).toContain("p.category_code");
	});

	test("leaves statements belonging to other tables alone", () => {
		const source = [
			"CREATE TABLE points (id INTEGER PRIMARY KEY, category_id TEXT);",
			"CREATE TABLE other (id INTEGER PRIMARY KEY, category_id TEXT);",
			"INSERT INTO other (category_id) VALUES ('x');",
		].join("\n\n");
		const model = parse_ddl_file(source, "x.sql", "sqlite");

		const touched = apply_column_renames(model, [{ table: "points", from: "category_id", to: "category_code" }]);
		expect(touched).toEqual([]);
		expect(model.statements[2]!.text).toContain("(category_id)");
	});

	test("does not rewrite a column whose name merely contains the old name", () => {
		const source = [
			"CREATE TABLE points (id INTEGER PRIMARY KEY, ts TEXT);",
			"INSERT INTO points (ts, ts_extra) VALUES ('a', 'b');",
		].join("\n\n");
		const model = parse_ddl_file(source, "x.sql", "sqlite");

		apply_column_renames(model, [{ table: "points", from: "ts", to: "created_ts" }]);
		expect(model.statements[1]!.text).toContain("(created_ts, ts_extra)");
	});

	test("returns no changes when there are no renames", () => {
		const model = parse_ddl_file("CREATE TABLE points (id INTEGER PRIMARY KEY);", "x.sql", "sqlite");
		expect(apply_column_renames(model, [])).toEqual([]);
	});
});

describe("detect_column_renames", () => {
	test("detects a rename by comparing against the source column index", () => {
		const source = table_of("points", ["id", "category_id"]);
		const edited = table_of("points", ["id", "category_code"]);
		const renames = detect_column_renames(source, edited, [0, 1]);
		expect(renames).toEqual([{ table: "points", from: "category_id", to: "category_code" }]);
	});

	test("ignores newly added columns, which have no source index", () => {
		const source = table_of("points", ["id"]);
		const edited = table_of("points", ["id", "brand_new"]);
		expect(detect_column_renames(source, edited, [0, null])).toEqual([]);
	});

	test("reports nothing when names are unchanged", () => {
		const source = table_of("points", ["id", "category_id"]);
		const edited = table_of("points", ["id", "category_id"]);
		expect(detect_column_renames(source, edited, [0, 1])).toEqual([]);
	});
});

function table_of(name: string, column_names: string[]): StudioTable {
	const columns: StudioColumn[] = column_names.map((column_name) => ({
		name: column_name,
		type_string: "TEXT",
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: [],
	}));
	return { name, columns, table_foreign_keys: [], table_suffix_raw: "" };
}
